import { assertEquals, assertRejects, assertStringIncludes } from "std/assert/mod.ts";
import { type FetchLike, HubSpotClient } from "./hubspot.ts";

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

interface CannedResponse {
  status?: number;
  body?: unknown;
}

/** A fake transport: records calls and returns queued responses in order. */
function mockFetch(responses: CannedResponse[]) {
  const calls: RecordedCall[] = [];
  let idx = 0;
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses[idx] ?? responses[responses.length - 1] ?? {};
    idx++;
    const status = r.status ?? 200;
    return Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchImpl, calls };
}

function client(responses: CannedResponse[]) {
  const { fetchImpl, calls } = mockFetch(responses);
  return { hs: new HubSpotClient({ token: "test-token", fetchImpl }), calls };
}

Deno.test("request attaches bearer auth header", async () => {
  const { fetchImpl, calls } = mockFetch([{ body: { results: [] } }]);
  const hs = new HubSpotClient({ token: "secret-123", fetchImpl });
  await hs.searchDealsByName("Anything");
  // Header assertion via a second mock that inspects init.
  let seenAuth = "";
  const inspect: FetchLike = (_url, init) => {
    const headers = init?.headers as Record<string, string>;
    seenAuth = headers["Authorization"];
    return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
  };
  await new HubSpotClient({ token: "secret-123", fetchImpl: inspect }).searchDealsByName("x");
  assertEquals(seenAuth, "Bearer secret-123");
  assertEquals(calls.length, 1);
});

Deno.test("searchDealsByBbid groups results by unique_bb_id", async () => {
  const { hs, calls } = client([{
    body: {
      results: [
        { id: "1", properties: { unique_bb_id: "A", pipeline: "16363685" } },
        { id: "2", properties: { unique_bb_id: "A", pipeline: "99" } },
        { id: "3", properties: { unique_bb_id: "B", pipeline: "23038595" } },
      ],
    },
  }]);
  const map = await hs.searchDealsByBbid(["A", "B"]);
  assertEquals(map.get("A")?.length, 2);
  assertEquals(map.get("B")?.length, 1);
  assertStringIncludes(calls[0].url, "/crm/v3/objects/deals/search");
  assertEquals(calls[0].method, "POST");
});

Deno.test("searchDealsByBbid chunks ids into batches of 100", async () => {
  const ids = Array.from({ length: 150 }, (_, i) => `bb-${i}`);
  const { hs, calls } = client([{ body: { results: [] } }]);
  await hs.searchDealsByBbid(ids);
  assertEquals(calls.length, 2); // 100 + 50
  const firstBatch = (calls[0].body as { filterGroups: { filters: { values: string[] }[] }[] })
    .filterGroups[0].filters[0].values;
  assertEquals(firstBatch.length, 100);
});

Deno.test("searchDealsByName sends an exact-match filter", async () => {
  const { hs, calls } = client([{
    body: { results: [{ id: "9", properties: { dealname: "Acme - X" } }] },
  }]);
  const deals = await hs.searchDealsByName("Acme - X");
  assertEquals(deals.length, 1);
  const filter =
    (calls[0].body as { filterGroups: { filters: { operator: string; value: string }[] }[] })
      .filterGroups[0].filters[0];
  assertEquals(filter.operator, "EQ");
  assertEquals(filter.value, "Acme - X");
});

Deno.test("batchUpdateDeals matches on unique_bb_id via idProperty", async () => {
  const { hs, calls } = client([{ body: { status: "COMPLETE", results: [] } }]);
  await hs.batchUpdateDeals([
    { bbId: "A1", properties: { dealstage: "x" } },
    { bbId: "A2", properties: { dealstage: "y" } },
  ]);
  assertStringIncludes(calls[0].url, "/crm/v3/objects/deals/batch/update");
  const inputs = (calls[0].body as { inputs: { idProperty: string; id: string }[] }).inputs;
  assertEquals(inputs.length, 2);
  assertEquals(inputs[0].idProperty, "unique_bb_id");
  assertEquals(inputs[0].id, "A1");
});

Deno.test("upsertCompany creates when no match (search then POST)", async () => {
  const { hs, calls } = client([
    { body: { results: [] } }, // search → none
    { body: { id: "comp-1" } }, // create
  ]);
  const res = await hs.upsertCompany("acme.com", { name: "Acme" });
  assertEquals(res, { id: "comp-1", created: true });
  assertStringIncludes(calls[0].url, "/crm/v3/objects/companies/search");
  assertEquals(calls[1].method, "POST");
  assertStringIncludes(calls[1].url, "/crm/v3/objects/companies");
  assertEquals((calls[1].body as { properties: { domain: string } }).properties.domain, "acme.com");
});

Deno.test("upsertCompany updates when a match exists (search then PATCH)", async () => {
  const { hs, calls } = client([
    { body: { results: [{ id: "comp-9", properties: { domain: "acme.com" } }] } }, // search → found
    { body: { id: "comp-9" } }, // patch
  ]);
  const res = await hs.upsertCompany("acme.com", { name: "Acme" });
  assertEquals(res, { id: "comp-9", created: false });
  assertEquals(calls[1].method, "PATCH");
  assertStringIncludes(calls[1].url, "/crm/v3/objects/companies/comp-9");
});

Deno.test("upsertContact dedups by email; upsertDeal by unique_bb_id", async () => {
  const c1 = client([{ body: { results: [] } }, { body: { id: "ct-1" } }]);
  await c1.hs.upsertContact("a@b.com", { firstname: "A" });
  const contactSearch =
    (c1.calls[0].body as { filterGroups: { filters: { propertyName: string }[] }[] })
      .filterGroups[0].filters[0].propertyName;
  assertEquals(contactSearch, "email");

  const c2 = client([{ body: { results: [] } }, { body: { id: "dl-1" } }]);
  await c2.hs.upsertDeal("BB-1", { dealname: "X" });
  const dealBody = c2.calls[1].body as { properties: { unique_bb_id: string } };
  assertEquals(dealBody.properties.unique_bb_id, "BB-1");
});

Deno.test("createAssociation uses the v4 default-association endpoint with PUT", async () => {
  const { hs, calls } = client([{ status: 200, body: {} }]);
  await hs.createAssociation("deal", "111", "company", "222");
  assertEquals(calls[0].method, "PUT");
  assertEquals(
    calls[0].url,
    "https://api.hubapi.com/crm/v4/objects/deal/111/associations/default/company/222",
  );
});

Deno.test("request throws with the HTTP status on a non-ok response", async () => {
  const { hs } = client([{ status: 404, body: { message: "Not found" } }]);
  await assertRejects(() => hs.searchDealsByName("x"), Error, "404");
});
