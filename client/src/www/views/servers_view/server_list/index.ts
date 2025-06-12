/*
  Copyright 2021 The Outline Authors
  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at
       http://www.apache.org/licenses/LICENSE-2.0
  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import {Localizer} from '@outline/infrastructure/i18n';
import {css, html, LitElement} from 'lit';
import {customElement, property} from 'lit/decorators.js';

import '../server_list_item/server_card';
import {ServerListItem} from '../server_list_item';

@customElement('server-list')
export class ServerList extends LitElement {
  @property({type: Boolean}) darkMode = false;

  static styles = [
    css`
      :host {
        box-sizing: border-box;
        display: block;
        height: 100%;
        margin: 0 auto;
        padding: 8px;
        width: 100%;
      }

      server-row-card {
        margin: 0 auto 8px auto;
        height: auto;
      }

      /* TODO(daniellacosse): Remove the hard-coded heights. */
      server-hero-card {
        height: 400px;
      }

      .test-all-container {
        display: flex;
        justify-content: center;
        margin-top: 8px;
        margin-bottom: 8px;
        padding: 8px;
      }

      .test-all-button {
        --md-filled-button-container-color: var(--outline-primary);
        --md-filled-button-label-text-color: var(--outline-white);
      }

      .test-all-button md-circular-progress {
        --md-circular-progress-size: 16px;
        --md-circular-progress-active-indicator-color: var(--outline-white);
      }

      .test-all-button:disabled {
        opacity: 0.7;
      }
    `,
  ];

  @property({type: Object}) localize: Localizer = msg => msg;
  @property({type: Array}) servers: ServerListItem[] = [];

  render() {
    if (this.hasSingleServer) {
      return html`<server-hero-card
        ?darkMode=${this.darkMode}
        .localize=${this.localize}
        .server=${this.servers[0]}
      ></server-hero-card>`;
    } else {
      return html`
        ${this.servers.map(
          server =>
            html`<server-row-card
              ?darkMode=${this.darkMode}
              .localize=${this.localize}
              .server=${server}
            ></server-row-card>`
        )}
        ${this.hasMultipleServers
          ? html`
              <div class="test-all-container">
                <md-filled-button
                  class="test-all-button"
                  @click=${this.testAllServers}
                  ?disabled=${this.isAnyServerTesting}
                >
                  ${this.isAnyServerTesting
                    ? html`<md-circular-progress
                        slot="icon"
                        indeterminate
                      ></md-circular-progress>`
                    : html`<md-icon slot="icon">speed</md-icon>`}
                  ${this.localize('test-all-servers-speed')}
                </md-filled-button>
              </div>
            `
          : ''}
      `;
    }
  }

  private get hasSingleServer() {
    return this.servers.length === 1;
  }

  private get hasMultipleServers() {
    return this.servers.length > 1;
  }

  private get isAnyServerTesting() {
    return this.servers.some(server => server.isTesting);
  }

  private testAllServers() {
    this.dispatchEvent(
      new CustomEvent('TestAllServersRequested', {
        bubbles: true,
        composed: true,
      })
    );
  }
}
