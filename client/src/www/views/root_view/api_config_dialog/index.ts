/*
  Copyright 2024 The Outline Authors
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

import '@material/mwc-button';
import '@material/mwc-textfield';

import {Localizer} from '@outline/infrastructure/i18n';
import {css, html, LitElement} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';

@customElement('api-config-dialog')
export class ApiConfigDialog extends LitElement {
  @property({type: Object}) localize: Localizer = msg => msg;
  @property({type: Boolean}) open = false;
  @property({type: String}) initialApiUrl = '';
  @property({type: String}) initialApiPassword = '';
  @state() private apiUrl = '';
  @state() private apiPassword = '';
  @state() private isConfigured = false;
  @state() private showForm = false;

  static styles = css`
    :host {
      display: block;
    }

    .description {
      color: var(--outline-label-color);
      font-size: 0.9rem;
      line-height: 1.5;
      margin-bottom: 24px;
      text-align: center;
    }

    .form-group {
      margin-bottom: 20px;
    }

    mwc-textfield {
      width: 100%;
      --mdc-theme-primary: var(--outline-primary);
      --mdc-text-field-filled-border-color: var(--outline-hairline);
      --mdc-text-field-ink-color: var(--outline-text-color);
      --mdc-text-field-label-ink-color: var(--outline-label-color);
    }

    .button-container {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-top: 24px;
    }

    mwc-button {
      --mdc-theme-primary: var(--outline-primary);
      --mdc-theme-on-primary: white;
    }

    .secondary {
      --mdc-theme-primary: var(--outline-label-color);
    }

    fieldset {
      border: none;
      text-transform: uppercase;
    }

    .configured-status {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      color: var(--outline-success);
      margin-bottom: 24px;
    }

    mwc-icon {
      color: var(--outline-success);
    }
  `;

  updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);

    // Initialize form fields with stored values when dialog opens
    if (changedProperties.has('open') && this.open) {
      this.apiUrl = this.initialApiUrl;
      this.apiPassword = this.initialApiPassword;
      this.isConfigured = Boolean(
        this.initialApiUrl && this.initialApiPassword
      );
      this.showForm = !this.isConfigured;
    }
  }

  private handleApiUrlChange(e: Event) {
    const target = e.target as HTMLInputElement;
    this.apiUrl = target.value;
  }

  private handleApiPasswordChange(e: Event) {
    const target = e.target as HTMLInputElement;
    this.apiPassword = target.value;
  }

  private configureApi() {
    if (!this.apiUrl.trim() || !this.apiPassword.trim()) {
      alert(this.localize('api-config-validation-error'));
      return;
    }

    this.dispatchEvent(
      new CustomEvent('ConfigureApiRequested', {
        bubbles: true,
        composed: true,
        detail: {
          apiUrl: this.apiUrl.trim(),
          apiPassword: this.apiPassword.trim(),
        },
      })
    );
    this.isConfigured = true;
    this.showForm = false;
  }

  private fetchServers() {
    this.dispatchEvent(
      new CustomEvent('FetchApiServersRequested', {
        bubbles: true,
        composed: true,
      })
    );
  }

  private close() {
    this.dispatchEvent(
      new CustomEvent('HideApiConfigDialog', {
        bubbles: true,
        composed: true,
      })
    );
  }

  private toggleForm() {
    this.showForm = !this.showForm;
  }

  render() {
    return html`<md-dialog .open="${this.open}" @cancel=${this.close} quick>
      <header slot="headline" style="color: var(--outline-text-color);">
        ${this.localize('api-configuration')}
      </header>
      <article slot="content" style="color: var(--outline-text-color);">
        <div class="description">
          ${this.localize('api-config-description')}
        </div>

        ${this.isConfigured && !this.showForm
          ? html`
              <div class="configured-status">
                <mwc-icon>check_circle</mwc-icon>
                <span>${this.localize('api-configured')}</span>
              </div>
            `
          : null}
        ${this.showForm
          ? html`
              <div class="form-group">
                <mwc-textfield
                  label="${this.localize('api-url')}"
                  type="url"
                  .value=${this.apiUrl}
                  @input=${this.handleApiUrlChange}
                  placeholder="https://your-api-server.com/endpoint"
                  required
                ></mwc-textfield>
              </div>

              <div class="form-group">
                <mwc-textfield
                  label="${this.localize('api-password')}"
                  type="password"
                  .value=${this.apiPassword}
                  @input=${this.handleApiPasswordChange}
                  placeholder="${this.localize('enter-api-password')}"
                  required
                ></mwc-textfield>
              </div>
            `
          : null}

        <div class="button-container">
          ${this.showForm
            ? html`
                <mwc-button
                  raised
                  @click=${this.configureApi}
                  ?disabled=${!this.apiUrl.trim() || !this.apiPassword.trim()}
                >
                  ${this.localize('configure-api')}
                </mwc-button>
              `
            : html`
                <mwc-button outlined @click=${this.toggleForm}>
                  ${this.localize('configure-api')}
                </mwc-button>
              `}
          ${!this.showForm && this.isConfigured
            ? html`
                <mwc-button raised @click=${this.fetchServers}>
                  ${this.localize('fetch-servers-from-api')}
                </mwc-button>
              `
            : null}
        </div>
      </article>
      <fieldset slot="actions">
        <md-text-button @click=${this.close}>
          ${this.localize('close')}
        </md-text-button>
      </fieldset>
    </md-dialog>`;
  }
}
