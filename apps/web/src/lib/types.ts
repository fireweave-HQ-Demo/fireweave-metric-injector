export type SessionUser = {
  id: string;
  email: string;
  role: 'admin' | 'user';
};

export type Session = {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
};

export type VendorAccount = {
  id: string;
  label: string;
  vendorType: 'openobserve' | 'datadog' | 'sentry';
  credentialHint: string;
  credentialKind: 'api_key' | 'token' | 'email' | 'dsn_key';
  validatedAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type JobStatus = 'scheduled' | 'active' | 'paused' | 'completed' | 'failed';

export type JobSummary = {
  id: string;
  name: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
};

export type MetricDefinition = {
  id: string;
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  category: 'success' | 'error' | 'custom' | 'dependent';
  tags: Record<string, string>;
  dependsOn: string[];
  formula: string | null;
  evalOrder: number;
  successProbability: number | null;
  errorProbability: number | null;
};

export type FailureRow = {
  id: string;
  reason: string;
  payload: unknown;
  vendorAccountId: string | null;
  deliveryId: string | null;
  createdAt: string;
};

export type JobDetail = {
  id: string;
  name: string;
  status: JobStatus;
  fanoutMode: 'replicate' | 'split';
  timezone: string;
  virtualUserCount: number;
  peakRatePerSecond: number;
  successProbability: number;
  errorProbability: number;
  tickIntervalMs: number;
  startTime: string;
  endTime: string | null;
  lastSimulatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  vendorAccountIds: string[];
  definitions: MetricDefinition[];
  failures: FailureRow[];
};

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
};
