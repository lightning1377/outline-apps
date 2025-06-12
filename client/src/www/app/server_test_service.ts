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

import {VPNManagementAPI, ServerTestResult} from './api_server_repository';
import {pluginExec} from './plugin.cordova';
import {ServerLogsHandler, LogType} from './server_logs_handler';
import {Server, ServerRepository} from '../model/server';

export interface ServerTestCallbacks {
  onTestStart: (serverId: string) => void;
  onTestComplete: (serverId: string, result: ServerTestResult) => void;
  onTestError: (serverId: string, error: Error) => void;
  onAllTestsComplete: (results: ServerTestResult[]) => void;
  onServerConnectionChange: (serverId: string, connected: boolean) => void;
}

export interface NativeTestResult {
  tcpSuccess: boolean;
  udpSuccess: boolean;
  connectivitySuccess: boolean;
  downloadSpeedKBps: number;
  uploadSpeedKBps: number;
  latencyMs: number;
  downloadTestSuccess: boolean;
  uploadTestSuccess: boolean;
  tcpError?: string;
  udpError?: string;
  downloadTestError?: string;
  uploadTestError?: string;
}

export enum TestMode {
  DIRECT = 'direct', // Test using native connectivity testing (Android/iOS)
  VPN = 'vpn', // Test through VPN connection (original method)
  AUTO = 'auto', // Choose best method automatically
}

export class ServerTestService {
  private serverTestResults: Map<string, ServerTestResult> = new Map();
  private serversCurrentlyTesting: Set<string> = new Set();

  constructor(
    private vpnApi: VPNManagementAPI,
    private serverRepo: ServerRepository,
    private serverLogsHandler: ServerLogsHandler,
    private callbacks: ServerTestCallbacks,
    private testMode: TestMode = TestMode.AUTO
  ) {}

  /**
   * Test the speed of a single server
   */
  async testServerSpeed(
    serverId: string,
    mode: TestMode = this.testMode
  ): Promise<void> {
    // Prevent concurrent testing of the same server
    if (this.serversCurrentlyTesting.has(serverId)) {
      return;
    }

    try {
      const server = this.getServerByServerId(serverId);

      // Mark server as testing and notify UI
      this.serversCurrentlyTesting.add(serverId);
      this.callbacks.onTestStart(serverId);

      let result: ServerTestResult;

      // Choose testing method based on mode
      if (
        mode === TestMode.DIRECT ||
        (mode === TestMode.AUTO && this.isNativeTestingAvailable())
      ) {
        result = await this.testServerNative(serverId, server);
      } else {
        result = await this.testServerViaVPN(serverId, server);
      }

      this.serverTestResults.set(serverId, result);

      // Only log if server has a rowId (meaning it came from API)
      if (server.rowId) {
        this.logTestResults(server.rowId, result);
      }

      this.callbacks.onTestComplete(serverId, result);
    } catch (error) {
      const testError =
        error instanceof Error ? error : new Error(String(error));
      this.callbacks.onTestError(serverId, testError);
    } finally {
      // Always remove from testing set
      this.serversCurrentlyTesting.delete(serverId);
    }
  }

  /**
   * Test the speed of all servers
   */
  async testAllServers(mode: TestMode = this.testMode): Promise<void> {
    try {
      const servers = this.serverRepo.getAll();
      if (servers.length === 0) {
        throw new Error('No servers available to test');
      }

      // Mark all servers as testing
      servers.forEach(server => {
        if (!this.serversCurrentlyTesting.has(server.id)) {
          this.serversCurrentlyTesting.add(server.id);
          this.callbacks.onTestStart(server.id);
        }
      });

      let results: ServerTestResult[];

      // Choose testing approach based on mode
      if (mode === TestMode.DIRECT || mode === TestMode.AUTO) {
        results = await this.testAllServersNative(servers);
      } else {
        results = await this.testAllServersViaVPN(servers);
      }

      // Log results for servers that have rowId
      results.forEach(result => {
        const server = this.getServerByServerId(result.serverId);
        if (server?.rowId) {
          this.logTestResults(server.rowId, result);
        }
      });

      this.callbacks.onAllTestsComplete(results);
    } catch (error) {
      // Clear testing state for all servers on error
      this.serversCurrentlyTesting.forEach(serverId => {
        this.callbacks.onTestError(
          serverId,
          error instanceof Error ? error : new Error(String(error))
        );
      });
      this.serversCurrentlyTesting.clear();

      throw error;
    }
  }

  /**
   * Test a single server using native testing
   */
  private async testServerNative(
    serverId: string,
    server: Server
  ): Promise<ServerTestResult> {
    // Use native connectivity testing (Android/iOS)
    if (!this.isNativeTestingAvailable()) {
      throw new Error('Native testing not available on this platform');
    }

    return await this.performNativeConnectivityTest(serverId, server);
  }

  /**
   * Test multiple servers using native testing in parallel
   */
  private async testAllServersNative(
    servers: Server[]
  ): Promise<ServerTestResult[]> {
    // Check if native testing is available
    if (!this.isNativeTestingAvailable()) {
      throw new Error('Native testing not available on this platform');
    }

    // Test all servers in parallel using native testing
    const testPromises = servers.map(server =>
      this.performNativeConnectivityTest(server.id, server).catch(
        error =>
          ({
            serverId: server.id,
            downloadSpeedKBps: 0,
            uploadSpeedKBps: 0,
            latencyMs: 0,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            pingSuccess: false,
            downloadTestSuccess: false,
            uploadTestSuccess: false,
          }) as ServerTestResult
      )
    );

    const results = await Promise.all(testPromises);

    // Store results and update UI
    results.forEach(result => {
      this.serverTestResults.set(result.serverId, result);
      this.callbacks.onTestComplete(result.serverId, result);
      this.serversCurrentlyTesting.delete(result.serverId);
    });

    return results;
  }

  /**
   * Test a single server via VPN connection (original method)
   */
  private async testServerViaVPN(
    serverId: string,
    server: Server
  ): Promise<ServerTestResult> {
    // Check if server is already connected
    const wasConnected = await server.checkRunning();
    let shouldDisconnect = false;

    try {
      // If server is not connected, connect it first
      if (!wasConnected) {
        console.debug(`Connecting to server ${serverId} for speed test`);
        await server.connect();
        shouldDisconnect = true;
        this.callbacks.onServerConnectionChange(serverId, true);

        // Wait a moment for connection to stabilize
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Now test connectivity through the connected server
      const result = await this.vpnApi.testConnectivity();
      result.serverId = serverId;

      return result;
    } finally {
      // Disconnect if we connected the server ourselves
      if (shouldDisconnect) {
        try {
          console.debug(
            `Disconnecting from server ${serverId} after speed test`
          );
          await server.disconnect();
          this.callbacks.onServerConnectionChange(serverId, false);
        } catch (disconnectError) {
          console.warn(
            `Failed to disconnect after speed test: ${disconnectError}`
          );
        }
      }
    }
  }

  /**
   * Test multiple servers via VPN connections sequentially
   */
  private async testAllServersViaVPN(
    servers: Server[]
  ): Promise<ServerTestResult[]> {
    const results: ServerTestResult[] = [];

    // Test servers sequentially to avoid overwhelming the network
    for (const server of servers) {
      try {
        const result = await this.testServerViaVPN(server.id, server);
        results.push(result);
        this.callbacks.onTestComplete(server.id, result);
      } catch (error) {
        const failedResult: ServerTestResult = {
          serverId: server.id,
          downloadSpeedKBps: 0,
          uploadSpeedKBps: 0,
          latencyMs: 0,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          pingSuccess: false,
          downloadTestSuccess: false,
          uploadTestSuccess: false,
        };
        results.push(failedResult);
        this.callbacks.onTestError(
          server.id,
          error instanceof Error ? error : new Error(String(error))
        );
      }

      this.serversCurrentlyTesting.delete(server.id);
    }

    return results;
  }

  /**
   * Check if native connectivity testing is available (Android/iOS Cordova)
   */
  private isNativeTestingAvailable(): boolean {
    return (
      typeof window !== 'undefined' &&
      'cordova' in window &&
      (window.cordova?.platformId === 'android' ||
        window.cordova?.platformId === 'ios')
    );
  }

  /**
   * Perform native connectivity test using Android/iOS VPN service
   */
  private async performNativeConnectivityTest(
    serverId: string,
    server: Server
  ): Promise<ServerTestResult> {
    try {
      // Get the raw access key/transport config from the server
      const accessKey = await this.getServerAccessKey(server);

      // Call the native method using the proper pluginExec helper
      const result = await pluginExec<NativeTestResult | string>(
        'testServerConnectivity',
        accessKey
      );

      let parsedResult: NativeTestResult;

      // Handle different return formats from platforms
      if (typeof result === 'string') {
        // iOS returns JSON string
        try {
          parsedResult = JSON.parse(result) as NativeTestResult;
        } catch (parseError) {
          throw new Error(`Failed to parse iOS test result: ${parseError}`);
        }
      } else {
        // Android returns object directly
        parsedResult = result;
      }

      // Parse native test results
      const testResult: ServerTestResult = {
        serverId,
        downloadSpeedKBps: parsedResult.downloadSpeedKBps || 0,
        uploadSpeedKBps: parsedResult.uploadSpeedKBps || 0,
        latencyMs: parsedResult.latencyMs || 0,
        success: parsedResult.tcpSuccess === true,
        pingSuccess: parsedResult.tcpSuccess === true,
        downloadTestSuccess: parsedResult.downloadTestSuccess === true,
        uploadTestSuccess: parsedResult.uploadTestSuccess === true,
        error: parsedResult.tcpSuccess
          ? undefined
          : parsedResult.tcpError || 'Connection failed',
      };

      return testResult;
    } catch (error) {
      throw new Error(
        `Native connectivity test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get the access key/transport config for a server
   */
  private async getServerAccessKey(server: Server): Promise<string> {
    try {
      console.log('server', server);
      // Try to extract transport config from the server
      // The OutlineServer class has a tunnelConfig property that contains the transport config

      if ('tunnelConfig' in server) {
        const tunnelConfig = (
          server as unknown as {
            tunnelConfig?: {client?: string; firstHop?: string};
          }
        ).tunnelConfig;

        console.log('tunnelConfig', tunnelConfig);

        if (tunnelConfig?.client) {
          // The client field contains something like: "{transport: \"ss://...\"}\n"
          // We need to extract the actual transport config

          console.log('Raw client data:', tunnelConfig.client);

          // Extract ss:// URL using regex since the JSON is malformed (unquoted property names)
          const ssUrlMatch = tunnelConfig.client.match(/ss:\/\/[^"]+/);
          if (ssUrlMatch) {
            const ssUrl = ssUrlMatch[0];
            console.log('Extracted ss:// URL:', ssUrl);

            // The Go client expects YAML format with 'transport' field, not raw ss:// URL
            const yamlConfig = `transport: ${ssUrl}`;
            console.log('Generated YAML config:', yamlConfig);
            return yamlConfig;
          }

          // Fallback: try to parse as JSON after fixing property names
          try {
            // Fix the malformed JSON by adding quotes around property names
            const fixedJson = tunnelConfig.client
              .trim()
              .replace(/(\w+):/g, '"$1":'); // Add quotes around property names
            const clientData = JSON.parse(fixedJson);
            console.log('Parsed client data:', clientData);

            if (
              clientData.transport &&
              clientData.transport !== 'outline_link'
            ) {
              // Return YAML format
              const yamlConfig = `transport: ${clientData.transport}`;
              console.log(
                'Generated YAML config from parsed JSON:',
                yamlConfig
              );
              return yamlConfig;
            }
          } catch (parseError) {
            console.warn('Failed to parse client data as JSON:', parseError);
          }
        }
      }

      // Fallback: try to reconstruct transport config from server address
      if (server.address) {
        console.log('Using server address for reconstruction:', server.address);
        const addressMatch = server.address.match(/^(.+):(\d+)$/);
        if (addressMatch) {
          const host = addressMatch[1];
          const port = addressMatch[2];
          const ssUrl = `ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpkZWZhdWx0LXBhc3N3b3Jk@${host}:${port}`;
          const yamlConfig = `transport: ${ssUrl}`;
          console.log('Generated YAML config from address:', yamlConfig);
          return yamlConfig;
        }

        // If no port in address, assume default
        const ssUrl = `ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpkZWZhdWx0LXBhc3N3b3Jk@${server.address}:8388`;
        const yamlConfig = `transport: ${ssUrl}`;
        console.log(
          'Generated YAML config from address (default port):',
          yamlConfig
        );
        return yamlConfig;
      }

      // If we can't extract or reconstruct, throw error to fallback to web testing
      throw new Error('Unable to extract transport configuration from server');
    } catch (error) {
      console.warn('Failed to get server access key:', error);
      throw new Error('Access key not available - falling back to web testing');
    }
  }

  /**
   * Get test results for a specific server
   */
  getTestResult(serverId: string): ServerTestResult | undefined {
    return this.serverTestResults.get(serverId);
  }

  /**
   * Get all test results
   */
  getAllTestResults(): Map<string, ServerTestResult> {
    return new Map(this.serverTestResults);
  }

  /**
   * Check if a server is currently being tested
   */
  isServerBeingTested(serverId: string): boolean {
    return this.serversCurrentlyTesting.has(serverId);
  }

  /**
   * Get all servers currently being tested
   */
  getServersCurrentlyTesting(): Set<string> {
    return new Set(this.serversCurrentlyTesting);
  }

  /**
   * Clear test results for a specific server
   */
  clearTestResult(serverId: string): void {
    this.serverTestResults.delete(serverId);
  }

  /**
   * Clear all test results
   */
  clearAllTestResults(): void {
    this.serverTestResults.clear();
  }

  /**
   * Set the default test mode
   */
  setTestMode(mode: TestMode): void {
    this.testMode = mode;
  }

  /**
   * Get the current test mode
   */
  getTestMode(): TestMode {
    return this.testMode;
  }

  private getServerByServerId(serverId: string): Server {
    const server = this.serverRepo.getById(serverId);
    if (!server) {
      throw new Error(`Could not find server with ID ${serverId}`);
    }
    return server;
  }

  private logTestResults(serverRowId: string, result: ServerTestResult): void {
    if (result.pingSuccess !== undefined) {
      this.serverLogsHandler.addLog(
        serverRowId,
        LogType.PING_TEST,
        result.pingSuccess
      );
    }
    if (result.downloadTestSuccess !== undefined) {
      this.serverLogsHandler.addLog(
        serverRowId,
        LogType.DOWNLOAD_TEST,
        result.downloadTestSuccess
      );
    }
    if (result.uploadTestSuccess !== undefined) {
      this.serverLogsHandler.addLog(
        serverRowId,
        LogType.UPLOAD_TEST,
        result.uploadTestSuccess
      );
    }
  }
}
