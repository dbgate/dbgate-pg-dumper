export interface CanonicalDumpOptions {
  readonly ignoredMetadataPrefixes?: readonly string[];
  readonly sortAclStatements?: boolean;
  readonly sortCommentStatements?: boolean;
}

export interface DumpDifference {
  readonly firstByte: number;
  readonly firstLine: number;
  readonly archiveEntry?: string;
  readonly unifiedDiff: string;
}

const defaultMetadataPrefixes = ['-- Generated at:'];

export function canonicalizeDump(sql: string, options: CanonicalDumpOptions = {}): string {
  const ignoredPrefixes = options.ignoredMetadataPrefixes ?? defaultMetadataPrefixes;
  const lines = sql
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !ignoredPrefixes.some((prefix) => line.startsWith(prefix)));

  const normalized: string[] = [];
  let blank = false;
  for (const line of lines) {
    if (line.length === 0) {
      if (!blank) normalized.push('');
      blank = true;
    } else {
      normalized.push(line);
      blank = false;
    }
  }

  return sortIndependentStatements(
    normalized.join('\n').replace(/\n*$/u, '\n'),
    options.sortAclStatements ?? false,
    options.sortCommentStatements ?? false,
  );
}

function sortIndependentStatements(sql: string, sortAcl: boolean, sortComments: boolean): string {
  if (!sortAcl && !sortComments) return sql;
  const blocks = sql.split(/\n(?=(?:GRANT|REVOKE|COMMENT ON)\s)/u);
  const sortable = blocks.filter(
    (block) =>
      (sortAcl && /^(?:GRANT|REVOKE)\s/u.test(block)) ||
      (sortComments && /^COMMENT ON\s/u.test(block)),
  );
  if (sortable.length < 2) return sql;
  const ordered = [...sortable].sort((left, right) => left.localeCompare(right));
  let index = 0;
  return blocks.map((block) => (sortable.includes(block) ? ordered[index++]! : block)).join('\n');
}

export function describeDumpDifference(left: Buffer, right: Buffer): DumpDifference | undefined {
  if (left.equals(right)) return undefined;
  const limit = Math.min(left.length, right.length);
  let firstByte = 0;
  while (firstByte < limit && left[firstByte] === right[firstByte]) firstByte += 1;

  const leftText = left.toString('utf8');
  const rightText = right.toString('utf8');
  const firstLine = left.subarray(0, firstByte).toString('utf8').split(/\r?\n/u).length;
  const lines = leftText.split(/\r?\n/u);
  const archiveEntry = [...lines.slice(0, firstLine).reverse()].find((line) =>
    line.startsWith('-- Entry '),
  );

  return {
    firstByte,
    firstLine,
    ...(archiveEntry === undefined ? {} : { archiveEntry }),
    unifiedDiff: createUnifiedDiff(leftText, rightText, firstLine),
  };
}

function createUnifiedDiff(left: string, right: string, firstLine: number): string {
  const leftLines = left.split(/\r?\n/u);
  const rightLines = right.split(/\r?\n/u);
  const start = Math.max(0, firstLine - 4);
  const end = Math.min(Math.max(leftLines.length, rightLines.length), firstLine + 3);
  const body: string[] = [
    '--- dump-a.sql',
    '+++ dump-b.sql',
    `@@ -${String(start + 1)},${String(end - start)} +${String(start + 1)},${String(end - start)} @@`,
  ];
  for (let index = start; index < end; index += 1) {
    const leftLine = leftLines[index];
    const rightLine = rightLines[index];
    if (leftLine === rightLine) {
      body.push(` ${leftLine ?? ''}`);
    } else {
      if (leftLine !== undefined) body.push(`-${leftLine}`);
      if (rightLine !== undefined) body.push(`+${rightLine}`);
    }
  }
  return `${body.join('\n')}\n`;
}
