import type { RoundTripFixtureContext } from './roundTripHarness.js';

export async function createRoundTripFixture({
  client,
  major,
}: RoundTripFixtureContext): Promise<void> {
  await client.query(`
    CREATE SCHEMA roundtrip;
    CREATE SCHEMA "Unicode_🦊";
    CREATE TYPE roundtrip.mood AS ENUM ('sad', 'ok', 'happy');
    CREATE DOMAIN roundtrip.positive AS integer CHECK (VALUE > 0);

    CREATE SEQUENCE roundtrip.unusual_sequence
      START 10 INCREMENT 5 MINVALUE 5 MAXVALUE 1000 CACHE 1 CYCLE;

    CREATE TABLE roundtrip.values_with_key (
      id integer PRIMARY KEY,
      empty_or_null text,
      controls text,
      minimum_bigint bigint,
      precise numeric(50, 25),
      bytes bytea,
      local_time timestamp,
      absolute_time timestamptz,
      duration interval,
      identifier uuid,
      json_value json,
      jsonb_value jsonb,
      nested_array integer[][],
      integer_range int4range,
      address inet,
      point_value point,
      mood roundtrip.mood,
      positive roundtrip.positive
    );
    INSERT INTO roundtrip.values_with_key VALUES
      (1, '', E'line 1\\nline 2\\r\\n\\\\N\\n\\\\.\\\\', -9223372036854775808,
       1234567890123456789012345.1234567890123456789012345,
       decode(repeat('000102030405060708090a0b0c0d0e0f', 16), 'hex'),
       '2024-03-31 02:30:00', '2024-10-27 02:30:00+02',
       '2 years 3 mons 4 days 05:06:07.890123',
       '123e4567-e89b-12d3-a456-426614174000',
       '{"spacing": [1, 2], "null": null}', '{"nested": {"b": 2, "a": 1}}',
       ARRAY[[1,NULL],[3,4]], '[1,10)', '2001:db8::1/64', point(1.5, -2.25),
       'happy', 42),
      (2, NULL, '', 9223372036854775807, -0.0000000000000000000000001,
       decode('', 'hex'), NULL, NULL, NULL, NULL, NULL, '{}'::jsonb,
       ARRAY[ARRAY[NULL,NULL],ARRAY[NULL,NULL]]::integer[][], 'empty'::int4range,
       NULL, NULL, 'ok', 1);

    CREATE TABLE roundtrip.serial_table (
      id serial PRIMARY KEY,
      "select" text,
      "Mixed Case" text
    );
    INSERT INTO roundtrip.serial_table (id, "select", "Mixed Case")
      VALUES (5, 'reserved', 'emoji 🦊');
    SELECT pg_catalog.setval('roundtrip.serial_table_id_seq', 77, false);
    SELECT pg_catalog.setval('roundtrip.unusual_sequence', 25, true);

    CREATE TABLE "Unicode_🦊"."表" ("識別子" integer PRIMARY KEY, "値" text);
    INSERT INTO "Unicode_🦊"."表" VALUES (1, 'Žluťoučký kůň 🦊');

    CREATE TABLE roundtrip.mutual_a (id integer PRIMARY KEY, b_id integer);
    CREATE TABLE roundtrip.mutual_b (id integer PRIMARY KEY, a_id integer);
    ALTER TABLE roundtrip.mutual_a ADD CONSTRAINT mutual_a_b_fk
      FOREIGN KEY (b_id) REFERENCES roundtrip.mutual_b(id);
    ALTER TABLE roundtrip.mutual_b ADD CONSTRAINT mutual_b_a_fk
      FOREIGN KEY (a_id) REFERENCES roundtrip.mutual_a(id);
    INSERT INTO roundtrip.mutual_a VALUES (1, NULL);
    INSERT INTO roundtrip.mutual_b VALUES (1, 1);
    UPDATE roundtrip.mutual_a SET b_id = 1 WHERE id = 1;

    CREATE INDEX values_positive_partial ON roundtrip.values_with_key (precise)
      WHERE positive > 0;
    CREATE INDEX values_lower_expression ON roundtrip.values_with_key
      (lower(empty_or_null));
    COMMENT ON TABLE roundtrip.values_with_key IS E'quotes: '' and newline\\nsecond line';
    COMMENT ON COLUMN roundtrip.values_with_key.controls IS 'COPY control sequences';
  `);

  if (major >= 10) {
    await client.query(`
      CREATE TABLE roundtrip.identity_table (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        value text
      );
      INSERT INTO roundtrip.identity_table (id, value)
        OVERRIDING SYSTEM VALUE VALUES (101, 'identity');
      CREATE TABLE roundtrip.partitioned_items (
        id integer,
        bucket integer,
        PRIMARY KEY (id, bucket)
      )
        PARTITION BY RANGE (bucket);
      CREATE TABLE roundtrip.partitioned_items_low
        PARTITION OF roundtrip.partitioned_items FOR VALUES FROM (0) TO (10);
      INSERT INTO roundtrip.partitioned_items VALUES (1, 5);
    `);
  }
  if (major >= 12) {
    await client.query(`
      CREATE TABLE roundtrip.generated_values (
        base integer PRIMARY KEY,
        doubled integer GENERATED ALWAYS AS (base * 2) STORED
      );
      INSERT INTO roundtrip.generated_values (base) VALUES (21);
    `);
  }
  if (major >= 14) {
    await client.query(`
      ALTER TABLE roundtrip.values_with_key
        ADD COLUMN integer_multirange int4multirange DEFAULT '{[1,3),[7,9)}';
    `);
  }
}

export async function createRoundTripFixtureWithLargeObject(
  context: RoundTripFixtureContext,
): Promise<void> {
  await createRoundTripFixture(context);
  await context.client.query(`
    SELECT pg_catalog.lo_from_bytea(
      42420,
      pg_catalog.decode(
        (SELECT pg_catalog.string_agg(
           pg_catalog.lpad(pg_catalog.to_hex(i), 2, '0'),
           '' ORDER BY i
         )
         FROM pg_catalog.generate_series(0, 255) AS i),
        'hex'
      )
    );
    COMMENT ON LARGE OBJECT 42420 IS 'all byte values';
  `);
}

export async function createPhysicalOrderFixture(context: RoundTripFixtureContext): Promise<void> {
  await createRoundTripFixture(context);
  await context.client.query(`
    CREATE TABLE roundtrip.duplicate_bag (value text, marker integer);
    INSERT INTO roundtrip.duplicate_bag
      VALUES ('duplicate', 1), ('duplicate', 1), (NULL, 2);
  `);
}
