import axios, { AxiosAdapter, AxiosInstance, AxiosRequestConfig } from 'axios';

export interface RecordedRequest {
  method: string;
  url: string;
  body: string;
  headers: Record<string, unknown>;
}

export interface CannedResponse {
  status?: number;
  data?: unknown;
}

type Responder = (req: RecordedRequest) => CannedResponse;

/**
 * An axios instance whose adapter answers from a routing table instead of the
 * network. Routes are matched on `METHOD path-suffix`, so the same table works
 * for the absolute URL the token endpoint is called with and the relative path
 * the API client uses.
 *
 * This replaces HTTP-level interception (nock), which does not survive axios's
 * follow-redirects wrapper on this Node version, and it has the advantage of
 * making the actual request — URL, body, headers — assertable.
 */
export function mockHttp(routes: Record<string, CannedResponse | Responder>): {
  http: AxiosInstance;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];

  const adapter: AxiosAdapter = async (config: AxiosRequestConfig) => {
    const method = (config.method ?? 'get').toUpperCase();
    const url = `${config.baseURL ?? ''}${config.url ?? ''}`;
    const record: RecordedRequest = {
      method,
      url,
      body: typeof config.data === 'string' ? config.data : JSON.stringify(config.data ?? null),
      headers: (config.headers ?? {}) as Record<string, unknown>,
    };
    requests.push(record);

    const key = Object.keys(routes).find((candidate) => {
      const [routeMethod, suffix] = candidate.split(' ');
      return routeMethod === method && url.endsWith(suffix);
    });

    if (!key) {
      const error = new Error(`No mock route for ${method} ${url}`) as Error & { code: string };
      error.code = 'ERR_MOCK_UNMATCHED';
      throw error;
    }

    const route = routes[key];
    const { status = 200, data = {} } = typeof route === 'function' ? route(record) : route;

    if (status >= 400) {
      // Shaped like a real axios error so `axios.isAxiosError` and the
      // status-based branches in the production code behave identically.
      const error = new Error(`Request failed with status code ${status}`) as Error & {
        isAxiosError: boolean;
        response: { status: number; data: unknown };
        config: AxiosRequestConfig;
      };
      error.isAxiosError = true;
      error.response = { status, data };
      error.config = config;
      throw error;
    }

    return {
      data,
      status,
      statusText: 'OK',
      headers: {},
      config: config as never,
    };
  };

  return { http: axios.create({ adapter }), requests };
}
