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

import {ISPInfo} from './server_logs_handler';
import {ServerRepository} from '../model/server';

export type NetworkChangeCallback = (ispInfo: ISPInfo) => void;

export class NetworkChangeDetector {
  private checkInterval: number;
  private callback: NetworkChangeCallback | null;
  private lastNetworkInfo: string | null = null;
  private lastISPInfo: ISPInfo | null = null;
  private lastISPFetchTime = 0;
  private isRunning = true;
  private monitorTimer: number | null = null;
  private onlineHandler: () => void;
  private offlineHandler: () => void;
  private serverRepository: ServerRepository;

  constructor(
    serverRepository: ServerRepository,
    checkInterval = 30000,
    callback: NetworkChangeCallback | null = null,
    private ipgeolocationApiKey: string | null = null
  ) {
    this.serverRepository = serverRepository;
    this.checkInterval = checkInterval; // Convert to milliseconds
    this.callback = callback;

    // Set up online/offline event listeners for immediate network change detection
    this.onlineHandler = () => this.handleNetworkChange();
    this.offlineHandler = () => this.handleNetworkChange();

    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);

    // Start monitoring
    this.startMonitoring();

    // Fetch initial ISP info
    this.handleNetworkChange().catch(error => {
      console.error('Error in network change detection:', error);
    });
  }

  private async getActiveNetworkInfo(): Promise<string> {
    // In web environment, we can't get detailed network interface info
    // Instead, we'll use navigator.connection if available, otherwise basic connectivity info
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connection = (navigator as any).connection;

    let networkInfo = `online:${navigator.onLine}`;

    if (connection) {
      networkInfo += `,type:${connection.effectiveType || 'unknown'}`;
      networkInfo += `,downlink:${connection.downlink || 'unknown'}`;
      networkInfo += `,rtt:${connection.rtt || 'unknown'}`;
    }

    return networkInfo;
  }

  private async fetchISPInfo(retries = 3): Promise<ISPInfo> {
    const apis = [
      {
        name: 'ipapi.co',
        url: 'https://ipapi.co/json/',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mapResponse: (data: any) => ({
          isp: data.org || 'Unknown ISP',
          org: data.org || 'Unknown Organization',
          country: data.country_name,
          countryCode: data.country_code,
          region: data.region,
          city: data.city,
        }),
      },
      {
        name: 'ipinfo.io',
        url: 'https://ipinfo.io/json',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mapResponse: (data: any) => ({
          isp: data.org || 'Unknown ISP',
          org: data.org || 'Unknown Organization',
          country: data.country,
          countryCode: data.country,
          region: data.region,
          city: data.city,
        }),
      },
      {
        name: 'ipgeolocation.io',
        url: `https://api.ipgeolocation.io/ipgeo?apiKey=${this.ipgeolocationApiKey}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mapResponse: (data: any) => ({
          isp: data.isp || data.organization || 'Unknown ISP',
          org: data.organization || data.isp || 'Unknown Organization',
          country: data.country_name,
          countryCode: data.country_code2,
          region: data.state_prov,
          city: data.city,
        }),
      },
    ];

    for (let attempt = 0; attempt < retries; attempt++) {
      for (const api of apis) {
        try {
          console.debug(
            `Trying ${api.name} (attempt ${attempt + 1}/${retries})`
          );

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);

          const response = await fetch(api.url, {
            signal: controller.signal,
            method: 'GET',
            mode: 'cors',
          });

          clearTimeout(timeoutId);

          if (response.ok) {
            const data = await response.json();

            // Check if the response contains error information
            if (data.error || data.status === 'fail') {
              throw new Error(
                data.message || `${api.name} API returned error status`
              );
            }

            const mappedData = api.mapResponse(data);
            console.debug(
              `Successfully fetched ISP info from ${api.name}:`,
              mappedData
            );
            return mappedData;
          } else {
            throw new Error(
              `${api.name} API failed with status code ${response.status}`
            );
          }
        } catch (error) {
          console.warn(`${api.name} attempt ${attempt + 1} failed:`, error);

          if (attempt < retries - 1) {
            // Exponential backoff only for retries on the same API
            await new Promise(resolve =>
              setTimeout(resolve, Math.pow(2, attempt) * 1000)
            );
          }
        }
      }
    }

    console.error('All ISP APIs failed after retries');
    return {error: 'All ISP APIs failed after multiple attempts'};
  }

  private async isAnyServerConnected(): Promise<boolean> {
    const servers = this.serverRepository.getAll();

    // Check each server to see if any is running
    for (const server of servers) {
      try {
        const isRunning = await server.checkRunning();
        if (isRunning) {
          return true;
        }
      } catch (error) {
        console.warn(
          `Failed to check running status for server ${server.id}:`,
          error
        );
      }
    }

    return false;
  }

  private async handleNetworkChange(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const newNetworkInfo = await this.getActiveNetworkInfo();

      if (newNetworkInfo !== this.lastNetworkInfo) {
        this.lastNetworkInfo = newNetworkInfo;
        console.debug('Network change detected:', newNetworkInfo);

        const now = Date.now();
        // Throttle ISP fetches to at most once every 30 seconds
        if (now - this.lastISPFetchTime > 30000) {
          this.lastISPFetchTime = now;

          try {
            // Check if any server is connected
            const isAnyServerConnected = await this.isAnyServerConnected();
            if (!isAnyServerConnected) {
              const newISPInfo = await this.fetchISPInfo();

              // Check if ISP info actually changed
              const ispChanged =
                !this.lastISPInfo ||
                this.lastISPInfo.isp !== newISPInfo.isp ||
                this.lastISPInfo.org !== newISPInfo.org ||
                Boolean(this.lastISPInfo.error) !== Boolean(newISPInfo.error);

              if (ispChanged) {
                this.lastISPInfo = newISPInfo;
                console.debug('ISP info updated:', newISPInfo);

                if (this.callback) {
                  // Execute callback asynchronously
                  setTimeout(() => {
                    if (this.callback) {
                      this.callback(newISPInfo);
                    }
                  }, 0);
                }
              }
            } else {
              console.debug('Skipping ISP info fetch - server is connected');
            }
          } catch (error) {
            console.error('Failed to fetch ISP info:', error);
          }
        }
      }
    } catch (error) {
      console.error('Error in network change detection:', error);
    }
  }

  private startMonitoring(): void {
    this.monitorTimer = window.setInterval(() => {
      if (this.isRunning) {
        this.handleNetworkChange().catch(error => {
          console.error('Error in network change detection:', error);
        });
      }
    }, this.checkInterval);
  }

  public stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    // Clear the monitoring timer
    if (this.monitorTimer !== null) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }

    // Remove event listeners
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
  }

  public getCurrentISPInfo(): ISPInfo | null {
    return this.lastISPInfo;
  }
}
