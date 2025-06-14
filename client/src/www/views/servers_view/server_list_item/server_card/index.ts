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

import {Corner, type Menu} from '@material/web/menu/menu';

import {Localizer} from '@outline/infrastructure/i18n';
import {css, html, LitElement} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';
import {createRef, Ref, ref} from 'lit/directives/ref.js';

import '../../server_connection_indicator';
import './server_rename_dialog';
import {ServerListItem, ServerListItemElement, ServerListItemEvent} from '..';
import {ServerConnectionState} from '../../server_connection_indicator';

const sharedCSS = css`
  /* TODO(daniellacosse): reset via postcss */
  h2,
  span,
  footer,
  button,
  div {
    all: initial;
  }

  * {
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }

  :host {
    --server-name-size: 1rem;
    --server-address-size: 0.875rem;

    display: inline-block;
    height: 100%;
    position: relative;
    width: 100%;
  }

  .card {
    align-items: center;
    background: var(--outline-card-background);
    border-radius: var(--outline-corner);
    box-shadow: var(--outline-elevation);
    display: grid;
    gap: var(--outline-slim-gutter);
    grid-gap: var(--outline-slim-gutter);
    overflow: hidden;
    width: 100%;
  }

  .card-metadata {
    font-family: var(--outline-font-family);
    color: var(--outline-text-color);
    gap: var(--outline-slim-gutter);
    grid-area: metadata;
    display: flex;
    align-items: center;
  }

  server-connection-indicator {
    min-height: var(--min-indicator-size);
    max-height: var(--max-indicator-size);
  }

  .card-metadata-server-name,
  .card-metadata-server-address {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    font-family: var(--outline-font-family);
    overflow: hidden;
    text-overflow: ellipsis;
    -webkit-user-select: text;
    user-select: text;
  }

  .card-metadata-server-name {
    /* https://caniuse.com/?search=line-clamp */
    -webkit-line-clamp: 3;
    color: var(--outline-text-color);
    font-size: var(--server-name-size);
    margin-bottom: var(--outline-mini-gutter);
    /* To break the line in case a sequence of word characters is longer than the line.
       See https://github.com/Jigsaw-Code/outline-apps/issues/1372. */
    word-break: break-all;
  }

  .card-metadata-server-address {
    /* https://caniuse.com/?search=line-clamp */
    -webkit-line-clamp: 2;
    color: var(--outline-label-color);
    font-size: var(--server-address-size);
    word-break: break-all;
  }

  .card-menu {
    --md-menu-container-color: var(--outline-card-background);
  }

  .card-menu-button {
    align-self: start;
    grid-area: menu;
    position: relative;
  }

  .card-menu-button md-icon {
    color: var(--outline-text-color);
  }

  .card-footer {
    background: var(--outline-card-footer);
    border-top: var(--outline-hairline);
    box-sizing: border-box;
    grid-area: footer;
    padding: var(--outline-mini-gutter) var(--outline-gutter);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .card-error {
    color: var(--outline-error);
    margin: 0 var(--outline-slim-gutter);
  }

  .card-footer-button {
    --md-sys-color-primary: var(--outline-primary);

    text-transform: uppercase;
  }

  .test-button {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .test-button md-circular-progress {
    --md-circular-progress-size: 16px;
    --md-circular-progress-active-indicator-color: var(--outline-primary);
  }

  .test-button:disabled {
    opacity: 0.7;
    pointer-events: none;
  }

  .card-metadata-speed-test {
    margin-top: var(--outline-mini-gutter);
  }

  .speed-test-result {
    font-size: 0.75rem;
    font-family: var(--outline-font-family);
    padding: 2px 6px;
    border-radius: 4px;
    display: inline-block;
  }

  .speed-test-result > span {
    font-size: 0.75rem;
  }

  .speed-test-result.success {
    background-color: rgba(76, 175, 80, 0.1);
    color: #4caf50;
  }

  .speed-test-result.error {
    background-color: rgba(244, 67, 54, 0.1);
    color: #f44336;
  }

  .speed-test-latency {
    font-weight: 500;
  }

  .speed-test-separator {
    margin: 0 4px;
    opacity: 0.7;
  }

  .speed-test-download {
    color: #4caf50;
    font-weight: 500;
  }

  .speed-test-upload {
    color: #2196f3;
    font-weight: 500;
  }

  .speed-test-legacy {
    color: inherit;
  }
`;

// TODO(daniellacosse): wrap components in a closure to avoid unnecessary work
const getSharedComponents = (element: ServerListItemElement & LitElement) => {
  const {server, localize, menu, menuButton} = element;
  const isConnectedState = [
    ServerConnectionState.CONNECTING,
    ServerConnectionState.CONNECTED,
    ServerConnectionState.RECONNECTING,
  ].includes(server.connectionState);
  const hasErrorMessage = Boolean(server.errorMessageId);

  const messages = {
    serverName: server.name,
    error: hasErrorMessage ? localize(server.errorMessageId) : '',
    connectButton: localize(
      isConnectedState ? 'disconnect-button-label' : 'connect-button-label'
    ),
  };

  const dispatchers = {
    beginRename: () => (element.isRenameDialogOpen = true),
    submitRename: (event: CustomEvent) => {
      element.isRenameDialogOpen = false;

      element.dispatchEvent(
        new CustomEvent(ServerListItemEvent.RENAME, {
          detail: {serverId: event.detail.id, newName: event.detail.name},
          bubbles: true,
          composed: true,
        })
      );
    },
    forget: () =>
      element.dispatchEvent(
        new CustomEvent(ServerListItemEvent.FORGET, {
          detail: {serverId: server.id},
          bubbles: true,
          composed: true,
        })
      ),
    connectToggle: () =>
      element.dispatchEvent(
        new CustomEvent(
          isConnectedState
            ? ServerListItemEvent.DISCONNECT
            : ServerListItemEvent.CONNECT,
          {
            detail: {serverId: server.id},
            bubbles: true,
            composed: true,
          }
        )
      ),
    testSpeed: () =>
      element.dispatchEvent(
        new CustomEvent('TestServerSpeedRequested', {
          detail: {serverId: server.id},
          bubbles: true,
          composed: true,
        })
      ),
  };

  const handleMenuOpen = () => {
    const menuElement = menu.value;
    const menuButtonElement = menuButton.value;

    if (!menuElement) {
      return;
    }

    if (!menuElement.anchorElement) {
      menuElement.anchorElement = menuButtonElement;
    }

    menuElement.show();
  };

  return {
    messages,
    dispatchers,
    elements: {
      metadataText: html`
        <div class="card-metadata-text">
          <h2 class="card-metadata-server-name" id="server-name">
            ${messages.serverName}
          </h2>
          <label class="card-metadata-server-address">${server.address}</label>
          ${server.latencyMs !== undefined
            ? html`
                <div class="card-metadata-speed-test">
                  <span
                    class="speed-test-result ${server.speedTestSuccess
                      ? 'success'
                      : 'error'}"
                  >
                    ${server.speedTestSuccess
                      ? html`
                          <span class="speed-test-latency"
                            >${server.latencyMs}ms</span
                          >
                          ${server.downloadSpeedKBps !== undefined &&
                          server.uploadSpeedKBps !== undefined
                            ? html`
                                <span class="speed-test-separator">•</span>
                                <span class="speed-test-download"
                                  >↓${server.downloadSpeedKBps} KB/s</span
                                >
                                <span class="speed-test-separator">•</span>
                                <span class="speed-test-upload"
                                  >↑${server.uploadSpeedKBps} KB/s</span
                                >
                              `
                            : ''}
                        `
                      : localize(
                          'speed-test-failed-short',
                          'error',
                          server.speedTestError || 'Unknown error'
                        )}
                  </span>
                </div>
              `
            : ''}
        </div>
      `,
      menu: html`
        <md-menu
          ${ref(menu)}
          class="card-menu"
          menuCorner=${Corner.END_END}
          quick
        >
          <md-menu-item @click="${dispatchers.beginRename}">
            ${localize('server-rename')}
          </md-menu-item>
          <md-menu-item @click="${dispatchers.forget}">
            ${localize('server-forget')}
          </md-menu-item>
        </md-menu>
      `,
      menuButton: html`
        <md-icon-button
          ${ref(menuButton)}
          class="card-menu-button"
          @click=${handleMenuOpen}
        >
          <md-icon>more_vert</md-icon>
        </md-icon-button>
      `,
      footer: html`
        <footer class="card-footer">
          <md-text-button
            class="card-footer-button test-button"
            @click="${dispatchers.testSpeed}"
            title="${localize('test-server-speed')}"
            ?disabled=${server.isTesting}
          >
            ${server.isTesting
              ? html`<md-circular-progress
                  slot="icon"
                  indeterminate
                ></md-circular-progress>`
              : html`<md-icon slot="icon">speed</md-icon>`}
            ${localize('server-test-speed')}
          </md-text-button>
          <span class="card-error">${messages.error}</span>
          <md-text-button
            class="card-footer-button"
            @click="${dispatchers.connectToggle}"
            ?disabled=${hasErrorMessage}
          >
            ${messages.connectButton}
          </md-text-button>
        </footer>
      `,
      renameDialog: html`<server-rename-dialog
        .open=${element.isRenameDialogOpen}
        .localize=${localize}
        .serverId=${server.id}
        .serverName=${server.name}
        @cancel=${() => (element.isRenameDialogOpen = false)}
        @submit=${dispatchers.submitRename}
      ></server-rename-dialog>`,
    },
  };
};

/**
 * Display a Server as a part of a larger collection.
 */
@customElement('server-row-card')
export class ServerRowCard extends LitElement implements ServerListItemElement {
  @property({type: Boolean}) darkMode = false;
  @property({type: Object}) server: ServerListItem;
  @property({type: Object}) localize: Localizer;

  @state() isRenameDialogOpen = false;

  menu: Ref<Menu> = createRef();
  menuButton: Ref<HTMLElement> = createRef();

  static styles = [
    sharedCSS,
    css`
      .card {
        --min-indicator-size: calc(
          var(--server-name-size) + var(--outline-mini-gutter) +
            var(--server-address-size)
        );
        --max-indicator-size: calc(
          var(--outline-slim-gutter) + var(--server-name-size) +
            var(--outline-mini-gutter) + var(--server-address-size) +
            var(--outline-slim-gutter)
        );

        grid-template-columns: 0 1fr auto 0;
        grid-template-rows: 0 minmax(0, 1fr) auto;
        grid-template-areas:
          '. . . .'
          '. metadata menu .'
          'footer footer footer footer';
      }

      server-connection-indicator {
        float: left;
      }
    `,
  ];

  render() {
    const {elements} = getSharedComponents(this);

    return html`
      <div class="card">
        <div class="card-metadata" aria-labelledby="server-name">
          <server-connection-indicator
            ?darkMode=${this.darkMode}
            connection-state="${this.server.connectionState}"
          ></server-connection-indicator>
          ${elements.metadataText}
        </div>
        ${elements.menuButton} ${elements.footer}
      </div>
      ${elements.menu} ${elements.renameDialog}
    `;
  }
}

/**
 * Display a featured Server in a showcase.
 */
@customElement('server-hero-card')
export class ServerHeroCard
  extends LitElement
  implements ServerListItemElement
{
  @property({type: Object}) server: ServerListItem;
  @property({type: Object}) localize: Localizer;
  @property({type: Boolean}) darkMode = false;

  @state() isRenameDialogOpen = false;

  menu: Ref<Menu> = createRef();
  menuButton: Ref<HTMLElement> = createRef();

  static styles = [
    sharedCSS,
    css`
      .card {
        --min-indicator-size: 192px;
        /*
          TODO(daniellacosse): calc() in combination with grid in this way can be inconsistent on iOS.
          May be resolved by autoprefixer as well.
        */
        --max-indicator-size: var(--min-indicator-size);

        grid-template-columns: 0 1fr auto 0;
        grid-template-rows: 0 auto minmax(0, 1fr) auto;
        grid-template-areas:
          '. . . .'
          '. metadata menu .'
          '. button button .'
          'footer footer footer footer';
      }

      .card-connection-button-container {
        grid-area: button;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        height: 100%;
        gap: var(--outline-slim-gutter);
        box-sizing: border-box;
        padding: var(--outline-large-gutter) 0;
      }

      server-connection-indicator {
        cursor: pointer;
      }

      .card-connection-label {
        color: var(--outline-label-color);
        font-size: var(--server-address-size);
        font-family: var(--outline-font-family);
        padding-top: 0.5rem;
      }
    `,
  ];

  render() {
    const {elements, dispatchers, messages} = getSharedComponents(this);

    const connectionStatusText = this.localize(
      `${this.server.connectionState}-server-state`
    );
    const connectToggleKeyboardDispatcher = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      if (event.key === 'Enter') {
        dispatchers.connectToggle();
      }
    };

    return html`
      <div class="card">
        <div class="card-metadata" aria-labelledby="server-name">
          ${elements.metadataText}
        </div>
        ${elements.menuButton}
        <div class="card-connection-button-container">
          <server-connection-indicator
            @click="${!this.server.errorMessageId && dispatchers.connectToggle}"
            @keydown="${connectToggleKeyboardDispatcher}"
            connection-state="${this.server.connectionState}"
            ?darkMode="${this.darkMode}"
            id="${messages.connectButton}"
            role="button"
            tabindex="0"
            title="${connectionStatusText}"
          ></server-connection-indicator>
          <label class="card-connection-label" for="${messages.connectButton}">
            ${connectionStatusText}
          </label>
        </div>
        ${elements.footer}
      </div>
      ${elements.menu} ${elements.renameDialog}
    `;
  }
}
