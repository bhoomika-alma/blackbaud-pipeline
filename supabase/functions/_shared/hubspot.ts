// HubSpot CRM client. All HubSpot traffic in the app goes through here.
//
// Mockable by design: the constructor takes an optional `fetchImpl`, so unit
// tests inject a fake transport and never hit the network. Writes match on the
// custom unique property `unique_bb_id`.

import type { BackendConfig } from "./env.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HubSpotObject {
  id: string;
  properties: Record<string, string | null>;
}

export type HubSpotDeal = HubSpotObject;

export interface DealUpdate {
  bbId: string;
  properties: Record<string, string>;
}

export interface BatchResult {
  status?: string;
  results: HubSpotObject[];
  errors?: unknown[];
}

interface SearchResponse {
  total?: number;
  results: HubSpotObject[];
  paging?: { next?: { after?: string } };
}

interface RequestOptions {
  method?: string;
  body?: string;
}

const DEAL_PROPERTIES = ["unique_bb_id", "dealname", "pipeline", "dealstage", "amount"];

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface HubSpotClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export class HubSpotClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: HubSpotClientOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? "https://api.hubapi.com";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static fromConfig(config: BackendConfig, fetchImpl?: FetchLike): HubSpotClient {
    return new HubSpotClient({ token: config.hubspotToken, fetchImpl });
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: options.body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `HubSpot ${options.method ?? "GET"} ${path} failed: ${res.status} ${detail}`,
      );
    }
    if (res.status === 204) return undefined as T;
    return await res.json() as T;
  }

  private async searchAll(
    objectType: string,
    filters: Record<string, unknown>[],
    properties: string[],
  ): Promise<HubSpotObject[]> {
    const collected: HubSpotObject[] = [];
    let after: string | undefined;
    do {
      const body: Record<string, unknown> = {
        filterGroups: [{ filters }],
        properties,
        limit: 100,
      };
      if (after) body.after = after;
      const res = await this.request<SearchResponse>(
        `/crm/v3/objects/${objectType}/search`,
        { method: "POST", body: JSON.stringify(body) },
      );
      collected.push(...res.results);
      after = res.paging?.next?.after;
    } while (after);
    return collected;
  }

  /** Batch-search deals by `unique_bb_id` (≤100 per request). Grouped by bb_id. */
  async searchDealsByBbid(bbIds: string[]): Promise<Map<string, HubSpotDeal[]>> {
    const grouped = new Map<string, HubSpotDeal[]>();
    const unique = [...new Set(bbIds.map((v) => v?.trim()).filter((v) => !!v))] as string[];
    for (const batch of chunk(unique, 100)) {
      const deals = await this.searchAll(
        "deals",
        [{ propertyName: "unique_bb_id", operator: "IN", values: batch }],
        DEAL_PROPERTIES,
      );
      for (const deal of deals) {
        const key = deal.properties["unique_bb_id"] ?? "";
        const list = grouped.get(key) ?? [];
        list.push(deal);
        grouped.set(key, list);
      }
    }
    return grouped;
  }

  /** Exact-match search for deals by name. */
  async searchDealsByName(dealName: string): Promise<HubSpotDeal[]> {
    return await this.searchAll(
      "deals",
      [{ propertyName: "dealname", operator: "EQ", value: dealName }],
      DEAL_PROPERTIES,
    );
  }

  /** Batch-update deals matched on `unique_bb_id` (≤100 per request). */
  async batchUpdateDeals(updates: DealUpdate[]): Promise<BatchResult[]> {
    const results: BatchResult[] = [];
    for (const batch of chunk(updates, 100)) {
      const body = {
        inputs: batch.map((u) => ({
          idProperty: "unique_bb_id",
          id: u.bbId,
          properties: u.properties,
        })),
      };
      results.push(
        await this.request<BatchResult>("/crm/v3/objects/deals/batch/update", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    }
    return results;
  }

  /**
   * Batch-search existing records by a unique property (e.g. domain / email /
   * unique_bb_id), `propertyName IN [values]`, ≤100 per request + paginated.
   * Returns a map of propertyValue → object id for the records that exist.
   * Used to learn which records are NEW vs EXISTING before creating.
   */
  async batchSearchIds(
    objectType: string,
    propertyName: string,
    values: string[],
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const unique = [...new Set(values.map((v) => v?.trim()).filter((v) => !!v))] as string[];
    for (const group of chunk(unique, 100)) {
      const results = await this.searchAll(
        objectType,
        [{ propertyName, operator: "IN", values: group }],
        [propertyName],
      );
      for (const obj of results) {
        const key = obj.properties[propertyName];
        if (key && obj.id) found.set(key, obj.id);
      }
    }
    return found;
  }

  /**
   * Batch-create records (≤100 per request). Each input is a flat properties
   * object that MUST include `idProperty`. Returns idPropertyValue → new id.
   */
  async batchCreate(
    objectType: string,
    idProperty: string,
    inputs: Record<string, string>[],
  ): Promise<Map<string, string>> {
    const created = new Map<string, string>();
    for (const group of chunk(inputs, 100)) {
      const res = await this.request<BatchResult>(
        `/crm/v3/objects/${objectType}/batch/create`,
        {
          method: "POST",
          body: JSON.stringify({ inputs: group.map((properties) => ({ properties })) }),
        },
      );
      for (const obj of res.results) {
        const key = obj.properties?.[idProperty];
        if (key && obj.id) created.set(key, obj.id);
      }
    }
    return created;
  }

  /** Create a v4 default association between two objects. */
  async createAssociation(
    fromType: string,
    fromId: string,
    toType: string,
    toId: string,
  ): Promise<void> {
    await this.request<void>(
      `/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`,
      { method: "PUT" },
    );
  }
}
