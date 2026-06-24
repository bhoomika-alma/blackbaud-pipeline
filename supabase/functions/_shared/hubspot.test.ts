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

Deno.test("batchSearchIds returns propertyValue → id for existing records", async () => {
  const { hs, calls } = client([{
    body: {
      results: [
        { id: "comp-1", properties: { domain: "acme.com" } },
        { id: "comp-2", properties: { domain: "beta.org" } },
      ],
    },
  }]);
  const map = await hs.batchSearchIds("companies", "domain", ["acme.com", "beta.org", "gamma.io"]);
  assertEquals(map.get("acme.com"), "comp-1");
  assertEquals(map.get("beta.org"), "comp-2");
  assertEquals(map.has("gamma.io"), false); // not returned → treated as new
  assertStringIncludes(calls[0].url, "/crm/v3/objects/companies/search");
  const filter =
    (calls[0].body as { filterGroups: { filters: { operator: string; values: string[] }[] }[] })
      .filterGroups[0].filters[0];
  assertEquals(filter.operator, "IN");
  assertEquals(filter.values, ["acme.com", "beta.org", "gamma.io"]);
});

Deno.test("batchCreate posts to batch/create and maps results by idProperty", async () => {
  const { hs, calls } = client([{
    body: {
      results: [
        { id: "ct-1", properties: { email: "a@b.com" } },
        { id: "ct-2", properties: { email: "c@d.com" } },
      ],
    },
  }]);
  const map = await hs.batchCreate("contacts", "email", [
    { email: "a@b.com", firstname: "A" },
    { email: "c@d.com", firstname: "C" },
  ]);
  assertEquals(map.get("a@b.com"), "ct-1");
  assertEquals(map.get("c@d.com"), "ct-2");
  assertStringIncludes(calls[0].url, "/crm/v3/objects/contacts/batch/create");
  const inputs = (calls[0].body as { inputs: { properties: Record<string, string> }[] }).inputs;
  assertEquals(inputs[0].properties.email, "a@b.com");
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
