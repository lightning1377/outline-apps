// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

interface ApiServerData {
  row_id: string;
  server_link: string;
}

interface ApiResponse {
  status: number; // HTTP status code (200, 400, etc.)
  message: string;
  data?: ApiServerData[]; // Array of server objects with row_id and server_link
}

export interface ServerTestResult {
  serverId: string;
  downloadSpeedKBps: number;
  uploadSpeedKBps: number;
  latencyMs: number;
  success: boolean;
  error?: string;
  pingSuccess?: boolean;
  downloadTestSuccess?: boolean;
  uploadTestSuccess?: boolean;
}

export class VPNManagementAPI {
  private baseUrl: string = '';
  private apiPassword: string = '';

  setApiConfig(baseUrl: string, apiPassword: string): void {
    this.baseUrl = baseUrl;
    this.apiPassword = apiPassword;
  }

  private async postRequest(
    action: string,
    payload: Record<string, string> = {}
  ): Promise<ApiResponse> {
    if (!this.apiPassword || !this.baseUrl) {
      return {
        status: 400,
        message: 'API URL and/or password is missing.',
      };
    }

    const data = new FormData();
    data.append('password', this.apiPassword);
    data.append('action', action);

    // Add payload data to form
    Object.keys(payload).forEach(key => {
      data.append(key, payload[key]);
    });

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        body: data,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      return {
        status: 500,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async fetchServers(): Promise<ApiResponse> {
    return this.postRequest('fetch_servers');
  }

  async storeLogs(
    logs: Array<{type: string; isp: string; success: boolean}>
  ): Promise<ApiResponse> {
    if (!Array.isArray(logs)) {
      throw new Error('Logs must be provided as an array of objects.');
    }

    for (const log of logs) {
      if (!log.type || !log.isp || typeof log.success !== 'boolean') {
        throw new Error(
          "Each log entry must contain 'type', 'isp', and 'success' properties."
        );
      }
    }

    const payload = {
      action: 'store_logs',
      logs_array: JSON.stringify(logs),
    };

    return this.postRequest('store_logs', payload);
  }

  async testConnectivity(): Promise<ServerTestResult> {
    const startTime = performance.now();
    let pingSuccess = false;
    let bandwidthSuccess = false;
    let latencyMs = 0;
    let bandwidth = 0;
    let error: string | undefined;

    // Test basic connectivity (ping test)
    try {
      const connectivityTestUrl = 'https://httpbin.org/status/200';

      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 15000);

      try {
        const connectivityResponse = await fetch(connectivityTestUrl, {
          method: 'GET',
          signal: abortController.signal,
        });

        clearTimeout(timeoutId);

        if (!connectivityResponse.ok) {
          throw new Error(
            `Connectivity test failed: ${connectivityResponse.status}`
          );
        }

        latencyMs = Math.round(performance.now() - startTime);
        pingSuccess = true;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (pingError) {
      pingSuccess = false;
      latencyMs = Math.round(performance.now() - startTime);
      error =
        pingError instanceof Error ? pingError.message : String(pingError);
    }

    // Perform bandwidth test if ping was successful
    if (pingSuccess) {
      try {
        bandwidth = await this.performBandwidthTest();
        bandwidthSuccess = true;
      } catch (bandwidthError) {
        bandwidthSuccess = false;
        bandwidth = 0;
        // Only update error if we don't already have a ping error
        if (!error) {
          error =
            bandwidthError instanceof Error
              ? bandwidthError.message
              : String(bandwidthError);
        }
      }
    }

    return {
      serverId: '',
      downloadSpeedKBps: bandwidth, // Approximate as download speed for web-based testing
      uploadSpeedKBps: Math.round(bandwidth * 0.8), // Estimate upload as 80% of download
      latencyMs: latencyMs,
      success: pingSuccess && bandwidthSuccess,
      pingSuccess,
      downloadTestSuccess: bandwidthSuccess,
      uploadTestSuccess: bandwidthSuccess,
      error,
    };
  }

  private async performBandwidthTest(): Promise<number> {
    // Test with multiple data sizes to get a more accurate measurement
    const testSizes = [
      {bytes: 100 * 1024, url: 'https://httpbin.org/bytes/102400'}, // 100KB
      {bytes: 500 * 1024, url: 'https://httpbin.org/bytes/512000'}, // 500KB
      {bytes: 1024 * 1024, url: 'https://httpbin.org/bytes/1048576'}, // 1MB
    ];

    const bandwidthResults: number[] = [];

    for (const testSize of testSizes) {
      let bandwidthTimeoutId: NodeJS.Timeout | number | undefined;

      try {
        const bandwidthTestStart = performance.now();

        // Create timeout controller for cross-browser compatibility
        const bandwidthAbortController = new AbortController();
        bandwidthTimeoutId = setTimeout(
          () => bandwidthAbortController.abort(),
          30000
        );

        const bandwidthTestResponse = await fetch(testSize.url, {
          signal: bandwidthAbortController.signal,
        });

        if (!bandwidthTestResponse.ok) {
          console.warn(
            `Bandwidth test failed for ${testSize.bytes} bytes: ${bandwidthTestResponse.status}`
          );
          continue;
        }

        const bandwidthTestData = await bandwidthTestResponse.arrayBuffer();
        const bandwidthTestTime = performance.now() - bandwidthTestStart;

        // Calculate bandwidth in KB/s, ensuring we have valid timing
        if (bandwidthTestTime > 0 && bandwidthTestData.byteLength > 0) {
          const bandwidth =
            bandwidthTestData.byteLength / 1024 / (bandwidthTestTime / 1000);
          bandwidthResults.push(bandwidth);
        }
      } catch (error) {
        console.warn(
          `Bandwidth test failed for ${testSize.bytes} bytes:`,
          error
        );
        // Continue with other test sizes
      } finally {
        // Ensure timeout is always cleared
        if (bandwidthTimeoutId) {
          clearTimeout(bandwidthTimeoutId);
        }
      }
    }

    if (bandwidthResults.length === 0) {
      throw new Error('All bandwidth tests failed');
    }

    // Return the median bandwidth for better accuracy
    const sortedResults = bandwidthResults.sort((a, b) => a - b);
    const medianIndex = Math.floor(sortedResults.length / 2);

    let medianBandwidth;
    if (sortedResults.length % 2 === 0) {
      medianBandwidth =
        (sortedResults[medianIndex - 1] + sortedResults[medianIndex]) / 2;
    } else {
      medianBandwidth = sortedResults[medianIndex];
    }

    return Math.round(medianBandwidth);
  }
}
