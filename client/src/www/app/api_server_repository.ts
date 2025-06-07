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

  private async postRequest(action: string, payload: Record<string, any> = {}): Promise<ApiResponse> {
    if (!this.apiPassword || !this.baseUrl) {
      return {
        status: 400,
        message: 'API URL and/or password is missing.'
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
        body: data
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      return {
        status: 500,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async fetchServers(): Promise<ApiResponse> {
    return this.postRequest('fetch_servers');
  }

  async storeLogs(logs: Array<{type: string; isp: string; success: boolean}>): Promise<ApiResponse> {
    if (!Array.isArray(logs)) {
      throw new Error('Logs must be provided as an array of objects.');
    }

    for (const log of logs) {
      if (!log.type || !log.isp || typeof log.success !== 'boolean') {
        throw new Error("Each log entry must contain 'type', 'isp', and 'success' properties.");
      }
    }

    const payload = {
      action: 'store_logs',
      logs_array: JSON.stringify(logs)
    };

    return this.postRequest('store_logs', payload);
  }

  async testServerSpeed(serverId: string, serverName: string): Promise<ServerTestResult> {
    const startTime = Date.now();
    
    try {
      // Test basic connectivity by making a request to a known endpoint through the proxy
      // This is a simplified test - in production you might want to use more sophisticated methods
      const testUrl = 'https://www.google.com/generate_204'; // Returns 204 No Content quickly
      
      // Simulate connection test (in real implementation, you'd proxy this through the server)
      const response = await fetch(testUrl, {
        method: 'GET',
        // Note: In a real implementation, you would configure the request to go through the proxy server
        signal: AbortSignal.timeout(10000) // 10 second timeout
      });

      const responseTime = Date.now() - startTime;
      
      // Simulate bandwidth test with a small download
      const bandwidthTestStart = Date.now();
      const bandwidthTestResponse = await fetch('https://httpbin.org/bytes/1024', {
        signal: AbortSignal.timeout(15000) // 15 second timeout
      });
      const bandwidthTestData = await bandwidthTestResponse.arrayBuffer();
      const bandwidthTestTime = Date.now() - bandwidthTestStart;
      
      // Calculate bandwidth in KB/s
      const bandwidth = Math.round((bandwidthTestData.byteLength / 1024) / (bandwidthTestTime / 1000));

      return {
        serverId,
        responseTime,
        bandwidth,
        success: response.ok && bandwidthTestResponse.ok,
        error: response.ok && bandwidthTestResponse.ok ? undefined : 'Connection test failed'
      };
    } catch (error) {
      return {
        serverId,
        responseTime: Date.now() - startTime,
        bandwidth: 0,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testAllServers(servers: Array<{id: string; name: string}>): Promise<ServerTestResult[]> {
    const results: ServerTestResult[] = [];
    
    // Test servers concurrently with a limit to avoid overwhelming the network
    const concurrencyLimit = 3;
    for (let i = 0; i < servers.length; i += concurrencyLimit) {
      const batch = servers.slice(i, i + concurrencyLimit);
      const batchResults = await Promise.all(
        batch.map(server => this.testServerSpeed(server.id, server.name))
      );
      results.push(...batchResults);
    }
    
    return results;
  }
} 