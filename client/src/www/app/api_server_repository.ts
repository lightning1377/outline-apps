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

export interface ApiResponse {
  status: number; // HTTP status code (200, 400, etc.)
  message: string;
  data?: ApiServerData[]; // Array of server objects with row_id and server_link
}

export interface ServerTestResult {
  serverId: string;
  responseTime: number;
  bandwidth: number;
  success: boolean;
  error?: string;
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

    try {
      // Test basic connectivity through the current proxy/connection
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

        const responseTime = Math.round(performance.now() - startTime);

        // Perform bandwidth test while connected
        const bandwidth = await this.performBandwidthTest();

        return {
          serverId: '',
          responseTime,
          bandwidth,
          success: true,
          error: undefined,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      return {
        serverId: '',
        responseTime: Math.round(performance.now() - startTime),
        bandwidth: 0,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
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

  // Note: This method is now just for API compatibility
  // The actual server testing logic should be handled by the App class
  // which can manage server connections properly
  async testConnectivityBatch(
    serverCount: number
  ): Promise<ServerTestResult[]> {
    const results: ServerTestResult[] = [];

    // Test connectivity multiple times for statistical purposes
    for (let i = 0; i < serverCount; i++) {
      const result = await this.testConnectivity();
      result.serverId = `test-${i}`;
      results.push(result);
    }

    return results;
  }
}
