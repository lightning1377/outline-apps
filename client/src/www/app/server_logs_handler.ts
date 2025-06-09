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

import {VPNManagementAPI} from './api_server_repository';

export enum LogType {
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  PING_TEST = 'ping_test',
  BANDWIDTH_TEST = 'bandwidth_test',
}

export interface ServerLog {
  server_id: string;
  type: LogType;
  isp: string;
  success: boolean;
  timestamp?: number;
}

export interface ISPInfo {
  isp?: string;
  org?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  error?: string;
}

export class ServerLogsHandler {
  private static instance: ServerLogsHandler | null = null;
  private logs: ServerLog[] = [];
  private ispInfo: string | null = null;
  private isInitialized = false;
  private isRunning = true;
  private isSendingLogs = false;
  private periodicTimer: number | null = null;

  private constructor(private api: VPNManagementAPI) {
    if (!this.api) {
      throw new Error('VPNManagementAPI instance must be provided.');
    }

    // Start periodic log sending (every 5 minutes)
    this.startPeriodicLogSending();
    this.isInitialized = true;
  }

  public static getInstance(api?: VPNManagementAPI): ServerLogsHandler {
    if (!ServerLogsHandler.instance) {
      if (!api) {
        throw new Error(
          'VPNManagementAPI instance must be provided for first initialization.'
        );
      }
      ServerLogsHandler.instance = new ServerLogsHandler(api);
    }
    return ServerLogsHandler.instance;
  }

  public setISPInfo(ispInfo: ISPInfo): void {
    if (ispInfo.error) {
      console.warn('ISP info fetch failed:', ispInfo.error);
      this.ispInfo = 'unknown';
    } else {
      this.ispInfo = ispInfo.isp || ispInfo.org || 'unknown';
    }
  }

  public addLog(serverId: string, logType: LogType, success: boolean): void {
    // Ignore log if isp info is not fetched
    if (this.ispInfo === null) {
      return;
    }

    const log: ServerLog = {
      server_id: serverId,
      type: logType,
      isp: this.ispInfo,
      success,
      timestamp: Date.now(),
    };

    this.logs.push(log);
    console.debug(
      `Added log: ${logType} for server ${serverId}, success: ${success}`
    );

    // Trigger log sending if we have 5 or more logs
    if (this.logs.length >= 5) {
      this.triggerLogSending();
    }
  }

  private triggerLogSending(): void {
    if (this.isSendingLogs) {
      return; // Already sending logs
    }

    // Use setTimeout to simulate background thread behavior
    setTimeout(() => this.sendLogsBatch(), 0);
  }

  private startPeriodicLogSending(): void {
    const FIVE_MINUTES = 5 * 60 * 1000; // 5 minutes in milliseconds

    this.periodicTimer = window.setInterval(() => {
      if (this.isRunning) {
        this.triggerLogSending();
      }
    }, FIVE_MINUTES);
  }

  private async sendLogsBatch(): Promise<void> {
    if (this.isSendingLogs || this.logs.length === 0) {
      return;
    }

    this.isSendingLogs = true;

    // Copy logs to send and clear the list
    const logsToSend = [...this.logs];
    this.logs.length = 0;

    try {
      console.debug(`Sending ${logsToSend.length} logs to API`);
      const response = await this.api.storeLogs(logsToSend);

      if (response.status !== 200) {
        console.error(`Failed to send logs: ${response.message}`);
        // Add failed logs back to the queue for retry
        this.logs.unshift(...logsToSend);
      } else {
        console.debug(`Successfully sent ${logsToSend.length} logs`);
      }
    } catch (error) {
      console.error('Error while sending logs:', error);
      // Add logs back to the queue for retry
      this.logs.unshift(...logsToSend);
    } finally {
      this.isSendingLogs = false;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    // Clear periodic timer
    if (this.periodicTimer !== null) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }

    // Send any remaining logs
    await this.sendLogsBatch();
  }

  public static async cleanup(): Promise<void> {
    if (ServerLogsHandler.instance) {
      await ServerLogsHandler.instance.stop();
      ServerLogsHandler.instance = null;
    }
  }
}
