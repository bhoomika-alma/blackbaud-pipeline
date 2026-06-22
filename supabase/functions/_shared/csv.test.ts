import { assertEquals } from "std/assert/mod.ts";
import { parseCsv } from "./csv.ts";

Deno.test("parseCsv: header + rows keyed by header", () => {
  const { headers, records } = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
  assertEquals(headers, ["a", "b", "c"]);
  assertEquals(records, [
    { a: "1", b: "2", c: "3" },
    { a: "4", b: "5", c: "6" },
  ]);
});

Deno.test("parseCsv: handles quoted fields containing commas", () => {
  const { records } = parseCsv('name,note\n"Smith, John","a, b, c"\n');
  assertEquals(records[0], { name: "Smith, John", note: "a, b, c" });
});

Deno.test("parseCsv: trims cells and skips blank lines", () => {
  const { records } = parseCsv("a,b\n  x , y \n\n,\nz,w\n");
  assertEquals(records, [
    { a: "x", b: "y" },
    { a: "z", b: "w" },
  ]);
});

Deno.test("parseCsv: strips a leading BOM from the first header", () => {
  const { headers } = parseCsv("﻿Account Name,Stage\nAcme,Demonstrate\n");
  assertEquals(headers[0], "Account Name");
});

Deno.test("parseCsv: empty input yields no headers or records", () => {
  assertEquals(parseCsv(""), { headers: [], records: [] });
});
