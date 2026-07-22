import { describe, expect, it } from "vitest";

import {
  INITIAL_PRODUCT_SEARCH_STATE,
  productSelected,
  queryChanged,
  searchFailed,
  searchStarted,
  searchSucceeded,
  type ProductOption,
  type ProductSearchState,
} from "./product-search";

function option(id: string): ProductOption {
  return { id, name: `Product ${id}`, code: `CODE-${id}` };
}

/** Fresh search for `query`, issued as `requestId`. */
function startFreshSearch(
  state: ProductSearchState,
  query: string,
  requestId: number,
): ProductSearchState {
  return searchStarted(queryChanged(state, query, requestId - 1), requestId, null);
}

describe("product search · initial state", () => {
  it("starts without results so opening the form never loads the catalog", () => {
    expect(INITIAL_PRODUCT_SEARCH_STATE.items).toEqual([]);
    expect(INITIAL_PRODUCT_SEARCH_STATE.nextCursor).toBeNull();
    expect(INITIAL_PRODUCT_SEARCH_STATE.selected).toBeNull();
    expect(INITIAL_PRODUCT_SEARCH_STATE.status).toBe("idle");
    expect(INITIAL_PRODUCT_SEARCH_STATE.hasSearched).toBe(false);
  });
});

describe("product search · query changes", () => {
  it("resets results, cursor and selection when the query changes", () => {
    const searched = searchSucceeded(
      startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 1),
      1,
      [option("a")],
      "cursor-2",
    );
    const selected = productSelected(searched, option("a"));

    const state = queryChanged(selected, "ibupro", 2);

    expect(state.query).toBe("ibupro");
    expect(state.items).toEqual([]);
    expect(state.nextCursor).toBeNull();
    expect(state.selected).toBeNull();
    expect(state.hasSearched).toBe(false);
    expect(state.status).toBe("idle");
  });

  it("clears a previous error so the user can retry with a new query", () => {
    const failed = searchFailed(startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 1), 1);
    expect(failed.status).toBe("error");

    expect(queryChanged(failed, "amox", 2).status).toBe("idle");
  });
});

describe("product search · in-flight requests", () => {
  it("clears previous results when a fresh search starts", () => {
    const searched = searchSucceeded(
      startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 1),
      1,
      [option("a")],
      "cursor-2",
    );

    const state = searchStarted(searched, 2, null);

    expect(state.status).toBe("searching");
    expect(state.items).toEqual([]);
    expect(state.nextCursor).toBeNull();
  });

  it("keeps current results visible while loading more", () => {
    const searched = searchSucceeded(
      startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 1),
      1,
      [option("a")],
      "cursor-2",
    );

    const state = searchStarted(searched, 2, "cursor-2");

    expect(state.status).toBe("searching");
    expect(state.items).toEqual([option("a")]);
  });
});

describe("product search · out-of-order responses", () => {
  it("ignores a stale response that resolves after a newer search started", () => {
    const stale = startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 1);
    const fresh = searchStarted(queryChanged(stale, "ibupro", 2), 3, null);

    const state = searchSucceeded(fresh, 1, [option("stale")], "stale-cursor");

    expect(state).toBe(fresh);
    expect(state.items).toEqual([]);
    expect(state.nextCursor).toBeNull();
    expect(state.status).toBe("searching");
  });

  it("ignores a stale rejection so a live search is not marked as failed", () => {
    const stale = startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 1);
    const fresh = searchStarted(queryChanged(stale, "ibupro", 2), 3, null);

    const state = searchFailed(fresh, 1);

    expect(state).toBe(fresh);
    expect(state.status).toBe("searching");
  });

  it("ignores a response belonging to a request cancelled by a query change", () => {
    const inFlight = startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 1);
    const retyped = queryChanged(inFlight, "amoxicilina", 2);

    const state = searchSucceeded(retyped, 1, [option("late")], null);

    expect(state.items).toEqual([]);
    expect(state.query).toBe("amoxicilina");
  });

  it("accepts the response that matches the current request", () => {
    const fresh = startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 2);

    const state = searchSucceeded(fresh, 2, [option("a")], "cursor-2");

    expect(state.items).toEqual([option("a")]);
    expect(state.nextCursor).toBe("cursor-2");
    expect(state.status).toBe("idle");
    expect(state.hasSearched).toBe(true);
  });
});

describe("product search · load more", () => {
  it("appends the next page for the current query", () => {
    const first = searchSucceeded(
      startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 1),
      1,
      [option("a"), option("b")],
      "cursor-2",
    );
    const loading = searchStarted(first, 2, "cursor-2");

    const state = searchSucceeded(loading, 2, [option("c")], null);

    expect(state.items).toEqual([option("a"), option("b"), option("c")]);
    expect(state.nextCursor).toBeNull();
  });

  it("does not duplicate rows when pages overlap", () => {
    const first = searchSucceeded(
      startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 1),
      1,
      [option("a"), option("b")],
      "cursor-2",
    );
    const loading = searchStarted(first, 2, "cursor-2");

    const state = searchSucceeded(loading, 2, [option("b"), option("c")], null);

    expect(state.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("never mixes a page into the results of a different query", () => {
    const first = searchSucceeded(
      startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 1),
      1,
      [option("a")],
      "cursor-2",
    );
    const loading = searchStarted(first, 2, "cursor-2");
    const retyped = queryChanged(loading, "ibupro", 3);

    const state = searchSucceeded(retyped, 2, [option("b")], null);

    expect(state.items).toEqual([]);
  });
});

describe("product search · failures and recovery", () => {
  it("exposes an error status when the current search rejects", () => {
    const fresh = startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 1);

    const state = searchFailed(fresh, 1);

    expect(state.status).toBe("error");
    expect(state.items).toEqual([]);
  });

  it("keeps already loaded results when a load more fails", () => {
    const first = searchSucceeded(
      startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 1),
      1,
      [option("a")],
      "cursor-2",
    );
    const loading = searchStarted(first, 2, "cursor-2");

    const state = searchFailed(loading, 2);

    expect(state.status).toBe("error");
    expect(state.items).toEqual([option("a")]);
    expect(state.nextCursor).toBe("cursor-2");
  });

  it("recovers on a retry of the same query", () => {
    const failed = searchFailed(startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 1), 1);

    const retried = searchStarted(failed, 2, null);
    expect(retried.status).toBe("searching");

    const state = searchSucceeded(retried, 2, [option("a")], null);
    expect(state.status).toBe("idle");
    expect(state.items).toEqual([option("a")]);
  });
});

describe("product search · selection", () => {
  it("keeps the selected product id for submission", () => {
    const searched = searchSucceeded(
      startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "amoxi", 1),
      1,
      [option("a"), option("b")],
      null,
    );

    const state = productSelected(searched, option("b"));

    expect(state.selected).toEqual(option("b"));
    expect(state.items).toEqual([option("a"), option("b")]);
  });

  it("reports an empty result set only after a search resolved", () => {
    const fresh = startFreshSearch(INITIAL_PRODUCT_SEARCH_STATE, "zzz", 1);
    expect(fresh.hasSearched).toBe(false);

    const state = searchSucceeded(fresh, 1, [], null);

    expect(state.hasSearched).toBe(true);
    expect(state.items).toEqual([]);
  });
});
