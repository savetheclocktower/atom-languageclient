// The goal of this file is to deliver a `zadeh`-compatible API that can be
// used instead of `zadeh`. Nothing against the package, but it doesn't have a
// prebuild for Apple Silicon, and Pulsar doesn't realize it needs a rebuild to
// work.
//
// This issue is tracked in
//
// https://github.com/pulsar-edit/ppm/issues/126
//
// …but, considering how little `atom-languageclient` uses `zadeh`, it's
// probably worth leveraging the fuzzy-matcher API exposed by Pulsar at
// `atom.ui.fuzzyMatcher`.
//
// Since older versions of Pulsar don't yet expose the native fuzzy matcher, we
// fall back to `fuzzaldrin`. This is a bit paranoid, but at least it's an
// option without a native module.

import { filter as faFilter } from 'fuzzaldrin'

// Types taken from Zadeh.
interface IOptions {
  /** @default false */
  allowErrors?: boolean;
  /** @default true */
  usePathScoring?: boolean;
  /** @default false */
  useExtensionBonus?: boolean;
  /**
  * A path separator which is a string with length 1. Such as "/" or "". By default, this is chosen based on the
  * operating system.
  */
  pathSeparator?: "/" | "\\" | string;
  /** @deprecated: there is no major benefit by precomputing something just for the query. */
  preparedQuery?: never;
}

export declare type StringArrayFilterOptions = IOptions & {
  /** The maximum numbers of results to return */
  maxResults?: number;
}
export declare type ObjectArrayFilterOptions = StringArrayFilterOptions

/** An object that stores its `dataKey` in `DataKey` */
type ObjectWithKey<DataKey extends string | number = string | number> = {
  [dk in DataKey]: string;
} & Record<string | number, string>


// Types for Pulsar's built-in fuzzy-matcher,
type MatcherResult = {
  id: number,
  value: string,
  score?: number,
  matchIndexes?: number[]
}

type MatcherMatchOptions = {
  maxResults?: number,
  algorithm?: 'fuzzaldrin' | 'command-t',
  recordMatchIndexes?: boolean,
  numThreads?: number,
  maxGap?: number
}

// The interface to a matcher returned by `atom.ui.fuzzyMatcher.setCandidates`.
interface Matcher {
  setCandidates(candidates: string[]): Matcher
  match(query: string, options?: MatcherMatchOptions): MatcherResult[]
}

// An object filterer whose API is compatible with zadeh's
// `ObjectArrayFilterer`.
export class PulsarObjectArrayFilterer<DataKey extends string | number = string> {
  // The candidates are the things we actually want filtered…
  #candidates?: ObjectWithKey<DataKey>[]

  // …but the filterables are the string values for each candidate that we're
  // filtering on.
  #filterables?: string[]

  #dataKey?: DataKey

  // Pulsar's native `fuzzyMatcher` will handle filtering for us. Or, if this
  // is `null`, it means we're falling back to `fuzzaldrin`.
  #matcher: Matcher | null = null

  constructor(candidates?: ObjectWithKey<DataKey>[], dataKey?: DataKey) {
    this.#dataKey = dataKey
    if (detectPulsarFuzzyFinder()) {
      // @ts-ignore Need to update type definition
      this.#matcher = atom.ui.fuzzyMatcher.setCandidates([])
    }
    if (candidates && dataKey) {
      this.setCandidates(candidates, dataKey)
    }
  }

  setCandidates(candidates: ObjectWithKey<DataKey>[], dataKey: DataKey) {
    this.#candidates = candidates
    this.#filterables = candidates.map(c => c[dataKey] ?? '')
    if (this.#matcher) {
      this.#matcher.setCandidates(this.#filterables)
    }
  }

  filter(query: string, options: ObjectArrayFilterOptions = {}): ObjectWithKey<DataKey>[] {
    if (!this.#candidates) return []
    if (this.#matcher) {
      let indices = this.filterIndices(query, options)
      let results: ObjectWithKey<DataKey>[] = []
      for (let i of indices) {
        results.push(this.#candidates[i])
      }
      return results
    } else {
      if (!this.#dataKey || !this.#candidates) return []
      let results = faFilter<ObjectWithKey<DataKey>, DataKey>(
        this.#candidates,
        query as any as ObjectWithKey<DataKey>[DataKey],
        { key: this.#dataKey, maxResults: options.maxResults }
      )
      return results
    }
  }

  filterIndices(query: string, options: ObjectArrayFilterOptions = {}): number[] {
    if (this.#matcher) {
      let results = this.#matcher.match(query, { ...options, algorithm: 'command-t' })
      return results.map(r => r.id)
    } else {
      if (!this.#dataKey || !this.#candidates) return []
      let results = faFilter<ObjectWithKey<DataKey>, DataKey>(
        this.#candidates,
        query as any as ObjectWithKey<DataKey>[DataKey],
        { key: this.#dataKey, maxResults: options.maxResults }
      )
      return results.map(r => this.#candidates!.indexOf(r))
    }
  }
}

function detectPulsarFuzzyFinder() {
  // return false // TEMP
  if (!('atom' in global)) return false
  if (!('ui' in atom)) return false
  // @ts-ignore Need to update type definition
  if (!('fuzzyMatcher' in atom.ui)) return false
  return true
}
