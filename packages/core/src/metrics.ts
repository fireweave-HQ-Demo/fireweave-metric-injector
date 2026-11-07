export type MetricPoint = {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  value: number;
  timestamp: Date;
  tags: Record<string, string>;
};

export type IngestionResult = {
  accountId: string;
  ok: boolean;
  statusCode: number;
  acceptedCount: number;
  error?: string;
};

export type VendorAdapter = {
  validateCredentials(): Promise<boolean>;
  ingestMetrics(metrics: MetricPoint[], options: { batchId: string }): Promise<IngestionResult>;
};
