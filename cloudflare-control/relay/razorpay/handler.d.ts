export declare const RAZORPAY_ORIGIN: string;
export declare const ALLOWED: ReadonlyArray<{ method: string; path: string }>;
export declare const MAX_SKEW_SECONDS: number;

export declare function relaySignature(secret: string, timestamp: string, method: string, path: string, body: string): string;

export interface RelayResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export declare function handleRelay(input: {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
  secret: string | undefined;
  nowSeconds: number;
  fetchImpl: typeof fetch;
}): Promise<RelayResult>;
