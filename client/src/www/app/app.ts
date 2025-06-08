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

import {Localizer} from '@outline/infrastructure/i18n';
import {OperationTimedOut} from '@outline/infrastructure/timeout_promise';

import {VPNManagementAPI, ServerTestResult} from './api_server_repository';
import {Clipboard} from './clipboard';
import {EnvironmentVariables} from './environment';
import * as config from './outline_server_repository/config';
import {Settings, SettingsKey, Appearance} from './settings';
import {Updater} from './updater';
import {UrlInterceptor} from './url_interceptor';
import {VpnInstaller} from './vpn_installer';
import * as errors from '../model/errors';
import * as events from '../model/events';
import {Server, ServerRepository} from '../model/server';
import {OutlineErrorReporter} from '../shared/error_reporter';
import {ServerConnectionState, ServerListItem} from '../views/servers_view';
import {SERVER_CONNECTION_INDICATOR_DURATION_MS} from '../views/servers_view/server_connection_indicator';

enum OUTLINE_ACCESS_KEY_SCHEME {
  STATIC = 'ss',
  DYNAMIC = 'ssconf',
}

// If "possiblyInviteUul" is a URL whose fragment contains a Shadowsocks URL
// then return that Shadowsocks URL, otherwise return the original string.
export function unwrapInvite(possiblyInviteUrl: string): string {
  try {
    const url = new URL(possiblyInviteUrl);
    if (url.hash) {
      const decodedFragment = decodeURIComponent(url.hash);

      // Search in the fragment for ss:// for two reasons:
      //  - URL.hash includes the leading # (what).
      //  - When a user opens invite.html#ENCODEDSSURL in their browser, the website (currently)
      //    redirects to invite.html#/en/invite/ENCODEDSSURL. Since copying that redirected URL
      //    seems like a reasonable thing to do, let's support those URLs too.
      //  - Dynamic keys are not supported by the invite flow, so we don't need to check for them
      const possibleShadowsocksUrl = decodedFragment.substring(
        decodedFragment.indexOf(`${OUTLINE_ACCESS_KEY_SCHEME.STATIC}://`)
      );

      if (
        new URL(possibleShadowsocksUrl).protocol ===
        `${OUTLINE_ACCESS_KEY_SCHEME.STATIC}:`
      ) {
        return possibleShadowsocksUrl;
      }
    }
  } catch {
    // It wasn't an invite URL!
  }

  return possiblyInviteUrl;
}

// Returns true if the given url was a valid Outline invitation or
// access key
export function isOutlineAccessKey(url: string): boolean {
  if (!url) return false;

  // URL does not parse the hostname if the protocol is non-standard (e.g. non-http)
  // so we're using `startsWith`
  return (
    url.startsWith(`${OUTLINE_ACCESS_KEY_SCHEME.STATIC}://`) ||
    url.startsWith(`${OUTLINE_ACCESS_KEY_SCHEME.DYNAMIC}://`)
  );
}

const DEFAULT_SERVER_CONNECTION_STATUS_CHANGE_TIMEOUT = 600;

export class App {
  private localize: Localizer;
  private ignoredAccessKeys: {[accessKey: string]: boolean} = {};
  private serverConnectionChangeTimeouts: {[serverId: string]: boolean} = {};
  private vpnApi: VPNManagementAPI = new VPNManagementAPI();
  private serverTestResults: Map<string, ServerTestResult> = new Map();
  private serversCurrentlyTesting: Set<string> = new Set();

  // Feature flag to control whether dark mode is enabled
  // When set to true, the theme option will appear in the navigation menu
  // and the app will respect system theme or user theme selection
  // TODO: remove once appearance translations are ready
  private appearanceFeatureEnabled = false;

  constructor(
    private eventQueue: events.EventQueue,
    private serverRepo: ServerRepository,
    private rootEl: polymer.Base,
    private debugMode: boolean,
    urlInterceptor: UrlInterceptor | undefined,
    private clipboard: Clipboard,
    private errorReporter: OutlineErrorReporter,
    private settings: Settings,
    environmentVars: EnvironmentVariables,
    private updater: Updater,
    private installer: VpnInstaller,
    private quitApplication: () => void,
    document = window.document
  ) {
    this.localize = this.rootEl.localize.bind(this.rootEl);

    this.syncServersToUI();
    rootEl.appVersion = environmentVars.APP_VERSION;
    rootEl.appBuild = environmentVars.APP_BUILD_NUMBER;
    rootEl.errorReporter = this.errorReporter;

    if (urlInterceptor) {
      this.registerUrlInterceptionListener(urlInterceptor);
    } else {
      console.warn('no urlInterceptor, ss:// urls will not be intercepted');
    }

    this.clipboard.setListener(this.handleClipboardText.bind(this));

    this.updater.setListener(this.updateDownloaded.bind(this));

    // Register Cordova mobile foreground event to sync server connectivity.
    document.addEventListener(
      'resume',
      this.syncConnectivityStateToServerCards.bind(this)
    );

    // Register handlers for events fired by Polymer components.
    this.rootEl.$.serversView.addEventListener(
      'add-server',
      this.requestPromptAddServer.bind(this)
    );
    this.rootEl.addEventListener(
      'ShowAddServerDialog',
      this.showAddServerDialog.bind(this)
    );
    this.rootEl.addEventListener(
      'ShowNavigation',
      this.showNavigation.bind(this)
    );
    this.rootEl.addEventListener(
      'HideNavigation',
      this.hideNavigation.bind(this)
    );
    this.rootEl.addEventListener('ChangePage', this.changePage.bind(this));
    this.rootEl.addEventListener(
      'AddServerConfirmationRequested',
      this.requestAddServerConfirmation.bind(this)
    );
    this.rootEl.addEventListener(
      'AddServerRequested',
      this.requestAddServer.bind(this)
    );
    this.rootEl.addEventListener(
      'IgnoreServerRequested',
      this.requestIgnoreServer.bind(this)
    );
    this.rootEl.addEventListener(
      'ConnectPressed',
      this.connectServer.bind(this)
    );
    this.rootEl.addEventListener(
      'DisconnectPressed',
      this.disconnectServer.bind(this)
    );
    this.rootEl.addEventListener('ForgetPressed', this.forgetServer.bind(this));
    this.rootEl.addEventListener(
      'RenameRequested',
      this.renameServer.bind(this)
    );
    this.rootEl.addEventListener(
      'QuitPressed',
      this.quitApplication.bind(this)
    );
    this.rootEl.addEventListener(
      'AutoConnectDialogDismissed',
      this.autoConnectDialogDismissed.bind(this)
    );
    this.rootEl.addEventListener(
      'PrivacyTermsAcked',
      this.ackPrivacyTerms.bind(this)
    );
    this.rootEl.addEventListener(
      'SetLanguageRequested',
      this.setAppLanguage.bind(this)
    );
    this.rootEl.addEventListener(
      'ConfigureApiRequested',
      this.configureApi.bind(this)
    );
    this.rootEl.addEventListener(
      'FetchApiServersRequested',
      this.fetchApiServers.bind(this)
    );
    this.rootEl.addEventListener(
      'TestServerSpeedRequested',
      this.testServerSpeed.bind(this)
    );
    this.rootEl.addEventListener(
      'TestAllServersRequested',
      this.testAllServers.bind(this)
    );

    if (this.appearanceFeatureEnabled) {
      this.rootEl.showAppearanceView = true;
      this.setAppearance(
        this.settings.get(SettingsKey.APPEARANCE) as Appearance
      );
      this.rootEl.addEventListener(
        'SetAppearanceRequested',
        (event: CustomEvent) => {
          this.settings.set(SettingsKey.APPEARANCE, event.detail.appearance);
          this.setAppearance(event.detail.appearance);
        }
      );
    }

    // Register handlers for events published to our event queue.
    this.eventQueue.subscribe(
      events.ServerAdded,
      this.onServerAdded.bind(this)
    );
    this.eventQueue.subscribe(
      events.ServerForgotten,
      this.onServerForgotten.bind(this)
    );
    this.eventQueue.subscribe(
      events.ServerRenamed,
      this.onServerRenamed.bind(this)
    );
    this.eventQueue.subscribe(
      events.ServerForgetUndone,
      this.onServerForgetUndone.bind(this)
    );
    this.eventQueue.subscribe(
      events.ServerConnected,
      this.onServerConnected.bind(this)
    );
    this.eventQueue.subscribe(
      events.ServerDisconnecting,
      this.onServerDisconnecting.bind(this)
    );
    this.eventQueue.subscribe(
      events.ServerDisconnected,
      this.onServerDisconnected.bind(this)
    );
    this.eventQueue.subscribe(
      events.ServerReconnecting,
      this.onServerReconnecting.bind(this)
    );

    this.eventQueue.startPublishing();

    this.rootEl.$.addServerView.accessKeyValidator = async (
      accessKey: string
    ): Promise<boolean> => {
      try {
        await config.parseAccessKey(accessKey);
        return true;
      } catch {
        return false;
      }
    };
    if (!this.arePrivacyTermsAcked()) {
      this.displayPrivacyView();
    }

    // Initialize API configuration from stored settings
    const storedApiUrl = this.settings.get(SettingsKey.API_URL);
    const storedApiPassword = this.settings.get(SettingsKey.API_PASSWORD);
    if (storedApiUrl && storedApiPassword) {
      this.vpnApi.setApiConfig(storedApiUrl, storedApiPassword);
    }

    // Pass stored API credentials to the UI
    this.rootEl.storedApiUrl = storedApiUrl || '';
    this.rootEl.storedApiPassword = storedApiPassword || '';
  }

  showLocalizedError(error?: Error, toastDuration = 10000) {
    let toastMessage: string;
    let buttonMessage: string;
    let buttonHandler: () => void;
    let buttonLink: string;

    if (error instanceof errors.VpnPermissionNotGranted) {
      toastMessage = this.localize(
        'outline-plugin-error-vpn-permission-not-granted'
      );
    } else if (error instanceof errors.InvalidServerCredentials) {
      toastMessage = this.localize(
        'outline-plugin-error-invalid-server-credentials'
      );
    } else if (error instanceof errors.RemoteUdpForwardingDisabled) {
      toastMessage = this.localize(
        'outline-plugin-error-udp-forwarding-not-enabled'
      );
    } else if (error instanceof errors.ServerUnreachable) {
      toastMessage = this.localize('outline-plugin-error-server-unreachable');
    } else if (error instanceof errors.ServerUrlInvalid) {
      toastMessage = this.localize('error-invalid-access-key');
    } else if (error instanceof errors.ServerIncompatible) {
      toastMessage = this.localize('error-server-incompatible');
    } else if (error instanceof OperationTimedOut) {
      toastMessage = this.localize('error-timeout');
    } else if (error instanceof errors.ClientStartFailure && this.isWindows()) {
      // Fall through to `error-unexpected` for other platforms.
      toastMessage = this.localize('outline-plugin-error-antivirus');
      buttonMessage = this.localize('fix-this');
      buttonLink =
        'https://s3.amazonaws.com/outline-vpn/index.html#/en/support/antivirusBlock';
    } else if (error instanceof errors.ConfigureSystemProxyFailure) {
      toastMessage = this.localize('outline-plugin-error-routing-tables');
      buttonMessage = this.localize('contact-page-title');
      buttonHandler = () => {
        // TODO: Drop-down has no selected item, why not?
        this.rootEl.changePage('contact');
      };
    } else if (error instanceof errors.NoAdminPermissions) {
      toastMessage = this.localize('outline-plugin-error-admin-permissions');
    } else if (error instanceof errors.UnsupportedRoutingTable) {
      toastMessage = this.localize(
        'outline-plugin-error-unsupported-routing-table'
      );
    } else if (error instanceof errors.ServerAlreadyAdded) {
      toastMessage = this.localize(
        'error-server-already-added',
        'serverName',
        error.server.name
      );
    } else if (error instanceof errors.SystemConfigurationException) {
      toastMessage = this.localize('outline-plugin-error-system-configuration');
    } else if (error instanceof errors.ShadowsocksUnsupportedCipher) {
      toastMessage = this.localize(
        'error-shadowsocks-unsupported-cipher',
        'cipher',
        error.cipher
      );
    } else if (error instanceof errors.InvalidServiceConfiguration) {
      toastMessage = this.localize('error-connection-configuration');
      buttonMessage = this.localize('error-details');
      buttonHandler = () => {
        this.showErrorCauseDialog(error);
      };
    } else if (error instanceof errors.SessionConfigFetchFailed) {
      toastMessage = this.localize('error-connection-configuration-fetch');
      buttonMessage = this.localize('error-details');
      buttonHandler = () => {
        this.showErrorCauseDialog(error);
      };
    } else if (error instanceof errors.ProxyConnectionFailure) {
      toastMessage = this.localize('error-connection-proxy');
      buttonMessage = this.localize('error-details');
      buttonHandler = () => {
        this.showErrorCauseDialog(error);
      };
    } else if (error instanceof errors.SessionProviderError) {
      toastMessage = error.message;
      console.log(error, error.message, error.details);
      if (error.details) {
        buttonMessage = this.localize('error-details');
        buttonHandler = () => {
          alert(error.details);
        };
      }
    } else {
      const hasErrorDetails = Boolean(error.message || error.cause);
      toastMessage = this.localize('error-unexpected');

      if (hasErrorDetails) {
        buttonMessage = this.localize('error-details');
        buttonHandler = () => {
          this.showErrorCauseDialog(error);
        };
      }
    }

    // Defer by 500ms so that this toast is shown after any toasts that get shown when any
    // currently-in-flight domain events land (e.g. fake servers added).
    if (this.rootEl && this.rootEl.async) {
      this.rootEl?.async(() => {
        this.rootEl.showToast(
          toastMessage ?? error.message,
          toastDuration,
          buttonMessage,
          buttonHandler,
          buttonLink
        );
      }, 500);
    }
  }

  private async pullClipboardText() {
    try {
      const text = await this.clipboard.getContents();
      await this.handleClipboardText(text);
    } catch {
      console.warn('cannot read clipboard, system may lack clipboard support');
    }
  }

  private arePrivacyTermsAcked() {
    try {
      return this.settings.get(SettingsKey.PRIVACY_ACK) === 'true';
    } catch {
      console.error(
        'could not read privacy acknowledgement setting, assuming not acknowledged'
      );
    }
    return false;
  }

  private displayPrivacyView() {
    this.rootEl.$.serversView.hidden = true;
    this.rootEl.$.privacyView.open = true;
    this.rootEl.$.addServerView.open = false;
  }

  private ackPrivacyTerms() {
    this.rootEl.$.serversView.hidden = false;
    this.rootEl.$.privacyView.open = false;
    this.rootEl.showApiConfigDialog = true;
    this.settings.set(SettingsKey.PRIVACY_ACK, 'true');
  }

  private setAppLanguage(event: CustomEvent) {
    const languageCode = event.detail.languageCode;
    window.localStorage.setItem('overrideLanguage', languageCode);
    this.rootEl.setLanguage(languageCode);
    this.changeToDefaultPage();
  }

  private showAddServerDialog() {
    this.rootEl.$.addServerView.open = true;
  }

  private showNavigation() {
    this.rootEl.$.drawer.open = true;
  }

  private hideNavigation() {
    this.rootEl.$.drawer.open = false;
  }

  private changePage(event: CustomEvent) {
    this.rootEl.changePage(event.detail.page);
  }

  private async handleClipboardText(text: string) {
    // Shorten, sanitise.
    // Note that we always check the text, even if the contents are same as last time, because we
    // keep an in-memory cache of user-ignored access keys.
    text = text.substring(0, 1000).trim();
    try {
      await this.confirmAddServer(text, true);
    } catch {
      // Don't alert the user; high false positive rate.
    }
  }

  private updateDownloaded() {
    this.rootEl.showToast(this.localize('update-downloaded'), 60000);
  }

  private requestPromptAddServer() {
    void this.pullClipboardText();
  }

  // Caches an ignored server access key so we don't prompt the user to add it again.
  private requestIgnoreServer(event: CustomEvent) {
    const accessKey = event.detail.accessKey;
    this.ignoredAccessKeys[accessKey] = true;
    this.rootEl.$.addServerView.open = false;
  }

  private requestAddServer(event: CustomEvent) {
    this.serverRepo
      .add(event.detail.accessKey)
      .catch(err => {
        this.changeToDefaultPage();
        this.showLocalizedError(err);
      })
      .finally(() => {
        this.rootEl.$.addServerView.open = false;
      });
  }

  private async requestAddServerConfirmation(event: CustomEvent) {
    const accessKey = event.detail.accessKey;
    console.debug('Got add server confirmation request from UI');
    try {
      await this.confirmAddServer(accessKey);
    } catch (err) {
      console.error('Failed to confirm add sever.', err);
      this.showLocalizedError(err);
    }
  }

  private async confirmAddServer(accessKey: string, fromClipboard = false) {
    const addServerView = this.rootEl.$.addServerView;
    accessKey = unwrapInvite(accessKey);
    if (fromClipboard && !addServerView.open) {
      if (accessKey in this.ignoredAccessKeys) {
        return console.debug('Ignoring access key');
      } else if (accessKey.startsWith('https://')) {
        return console.debug(
          'Non-Invite https:// keys should be pasted in explicitly.'
        );
      }
    }
    try {
      await config.parseAccessKey(accessKey);
      addServerView.accessKey = accessKey;
      addServerView.open = true;
    } catch (e) {
      if (!fromClipboard && e instanceof errors.ServerAlreadyAdded) {
        // Display error message and don't propagate error if this is not a clipboard add.
        addServerView.open = false;
        this.showLocalizedError(e);
        return;
      }
      // Propagate access key validation error.
      throw e;
    }
  }

  private async forgetServer(event: CustomEvent) {
    event.stopImmediatePropagation();

    const {serverId} = event.detail;
    const server = this.serverRepo.getById(serverId);
    if (!server) {
      console.error(`No server with id ${serverId}`);
      return this.showLocalizedError();
    }
    try {
      if (await server.checkRunning()) {
        await this.disconnectServer(event);
      }
    } catch (e) {
      console.warn(`failed to disconnect from server to forget: ${e}`);
    }
    this.serverRepo.forget(serverId);
  }

  private renameServer(event: CustomEvent) {
    const {serverId, newName} = event.detail;
    this.serverRepo.rename(serverId, newName);
  }

  private async connectServer(event: CustomEvent) {
    event.stopImmediatePropagation();

    const {serverId} = event.detail;
    if (!serverId) {
      throw new Error('connectServer event had no server ID');
    }

    if (
      this.throttleServerConnectionChange(
        serverId,
        DEFAULT_SERVER_CONNECTION_STATUS_CHANGE_TIMEOUT
      )
    )
      return;

    const server = this.getServerByServerId(serverId);
    console.log(`connecting to server ${serverId}`);

    this.updateServerListItem(serverId, {
      connectionState: ServerConnectionState.CONNECTING,
    });
    try {
      await server.connect();
      this.updateServerListItem(serverId, {
        connectionState: ServerConnectionState.CONNECTED,
        address: server.address,
      });
      console.log(`connected to server ${serverId}`);
      this.rootEl.showToast(
        this.localize('server-connected', 'serverName', server.name)
      );
      this.maybeShowAutoConnectDialog();
    } catch (e) {
      this.updateServerListItem(serverId, {
        connectionState: ServerConnectionState.DISCONNECTED,
      });
      console.error(`could not connect to server ${serverId}: ${e}`);
      if (
        e instanceof errors.ProxyConnectionFailure &&
        e.cause instanceof errors.SystemConfigurationException
      ) {
        const confirmation =
          this.localize('outline-services-installation-confirmation') +
          '\n\n--------------------\n' +
          e.toString();
        if (await this.showConfirmationDialog(confirmation)) {
          await this.installVpnService();
          return;
        }
      }
      this.showLocalizedError(e);
    }
  }

  private async installVpnService(): Promise<void> {
    this.rootEl.showToast(
      this.localize('outline-services-installing'),
      Infinity
    );
    try {
      await this.installer.installVpn();
      this.rootEl.showToast(this.localize('outline-services-installed'));
    } catch (e) {
      const err = e.errorCode ? errors.fromErrorCode(e.errorCode) : e;
      console.error('failed to set up Outline VPN', err);
      if (err instanceof errors.UnexpectedPluginError) {
        this.rootEl.showToast(
          this.localize('outline-services-installation-failed')
        );
      } else {
        this.showLocalizedError(err);
      }
    }
  }

  private maybeShowAutoConnectDialog() {
    let dismissed = false;
    try {
      dismissed =
        this.settings.get(SettingsKey.AUTO_CONNECT_DIALOG_DISMISSED) === 'true';
    } catch (e) {
      console.error(
        `Failed to read auto-connect dialog status, assuming not dismissed: ${e}`
      );
    }
    if (!dismissed) {
      this.rootEl.$.autoConnectDialog.open = true;
    }
  }

  private autoConnectDialogDismissed() {
    this.settings.set(SettingsKey.AUTO_CONNECT_DIALOG_DISMISSED, 'true');
    this.rootEl.$.autoConnectDialog.open = false;
  }

  private async disconnectServer(event: CustomEvent) {
    event.stopImmediatePropagation();

    const {serverId} = event.detail;
    if (!serverId) {
      throw new Error('disconnectServer event had no server ID');
    }

    if (
      this.throttleServerConnectionChange(
        serverId,
        DEFAULT_SERVER_CONNECTION_STATUS_CHANGE_TIMEOUT
      )
    )
      return;

    const server = this.getServerByServerId(serverId);
    console.log(`disconnecting from server ${serverId}`);

    this.updateServerListItem(serverId, {
      connectionState: ServerConnectionState.DISCONNECTING,
    });
    try {
      await server.disconnect();
      this.updateServerListItem(serverId, {
        connectionState: ServerConnectionState.DISCONNECTED,
      });

      // Wait until the server connection indicator is done animating to update the
      // address, which potentially will remove it.

      // TODO(daniellacosse): Server connection indicator should broadcast an
      // animationend event, which the app can respond to.
      this.rootEl.async(
        () =>
          this.updateServerListItem(serverId, {
            address: server.address,
          }),
        SERVER_CONNECTION_INDICATOR_DURATION_MS
      );

      console.log(`disconnected from server ${serverId}`);
      this.rootEl.showToast(
        this.localize('server-disconnected', 'serverName', server.name)
      );
    } catch (e) {
      this.updateServerListItem(serverId, {
        connectionState: ServerConnectionState.CONNECTED,
      });
      this.showLocalizedError(e);
      console.warn(`could not disconnect from server ${serverId}: ${e.name}`);
    }
  }

  //#region EventQueue event handlers

  private onServerConnected(event: events.ServerConnected): void {
    console.debug(`server ${event.serverId} connected`);
    this.updateServerListItem(event.serverId, {
      connectionState: ServerConnectionState.CONNECTED,
    });
  }

  private onServerDisconnected(event: events.ServerDisconnected): void {
    console.debug(`server ${event.serverId} disconnected`);
    try {
      this.updateServerListItem(event.serverId, {
        connectionState: ServerConnectionState.DISCONNECTED,
      });
    } catch {
      console.warn(
        'server card not found after disconnection event, assuming forgotten'
      );
    }
  }

  private onServerDisconnecting(event: events.ServerReconnecting): void {
    console.debug(`server ${event.serverId} disconnecting`);
    this.updateServerListItem(event.serverId, {
      connectionState: ServerConnectionState.DISCONNECTING,
    });
  }

  private onServerReconnecting(event: events.ServerReconnecting): void {
    console.debug(`server ${event.serverId} reconnecting`);
    this.updateServerListItem(event.serverId, {
      connectionState: ServerConnectionState.RECONNECTING,
    });
  }

  private onServerAdded(event: events.ServerAdded) {
    const server = event.server;
    console.debug('Server added');
    this.syncServersToUI();
    this.changeToDefaultPage();
    this.rootEl.showToast(
      this.localize('server-added', 'serverName', server.name)
    );
  }

  private onServerForgotten(event: events.ServerForgotten) {
    const server = event.server;
    console.debug('Server forgotten');
    this.syncServersToUI();
    this.rootEl.showToast(
      this.localize('server-forgotten', 'serverName', server.name),
      10000,
      this.localize('undo-button-label'),
      () => {
        this.serverRepo.undoForget(server.id);
      }
    );
  }

  private onServerForgetUndone(event: events.ServerForgetUndone) {
    this.syncServersToUI();
    const server = event.server;
    this.rootEl.showToast(
      this.localize('server-forgotten-undo', 'serverName', server.name)
    );
  }

  private onServerRenamed(event: events.ServerRenamed) {
    const server = event.server;
    console.debug('Server renamed');
    this.updateServerListItem(server.id, {name: server.name});
    this.rootEl.showToast(this.localize('server-rename-complete'));
  }

  //#endregion EventQueue event handlers

  //#region UI dialogs

  private showConfirmationDialog(message: string): Promise<boolean> {
    // Temporarily use window.confirm here
    return new Promise<boolean>(resolve => resolve(confirm(message)));
  }

  private showErrorCauseDialog(error: Error) {
    const makeString = (error: unknown, indent: string): string => {
      let message = indent + String(error);
      if (error instanceof Object && 'cause' in error && error.cause) {
        message += `\n${indent}Cause: `;
        message += makeString(error.cause, indent + '  ');
      }
      return message;
    };
    return this.rootEl.showErrorDetails(makeString(error, ''));
  }
  //#endregion UI dialogs

  // Helpers:

  private makeServerListItem(server: Server): ServerListItem {
    return {
      disabled: false,
      errorMessageId: server.errorMessageId,
      name: server.name,
      address: server.address,
      id: server.id,
      connectionState: ServerConnectionState.DISCONNECTED,
    };
  }

  private throttleServerConnectionChange(serverId: string, time: number) {
    if (this.serverConnectionChangeTimeouts[serverId]) return true;

    this.serverConnectionChangeTimeouts[serverId] = true;

    setTimeout(
      () => delete this.serverConnectionChangeTimeouts[serverId],
      time
    );

    return false;
  }

  private syncServersToUI() {
    this.rootEl.servers = this.serverRepo
      .getAll()
      .map(this.makeServerListItem.bind(this));
    this.syncConnectivityStateToServerCards();
  }

  private syncConnectivityStateToServerCards() {
    for (const server of this.serverRepo.getAll()) {
      void this.syncServerConnectivityState(server);
    }
  }

  private async syncServerConnectivityState(server: Server) {
    try {
      const isRunning = await server.checkRunning();
      const connectionState = isRunning
        ? ServerConnectionState.CONNECTED
        : ServerConnectionState.DISCONNECTED;
      this.updateServerListItem(server.id, {connectionState});
    } catch (e) {
      console.error('Failed to sync server connectivity state', e);
    }
  }

  private registerUrlInterceptionListener(urlInterceptor: UrlInterceptor) {
    urlInterceptor.registerListener(async url => {
      if (!isOutlineAccessKey(unwrapInvite(url))) {
        // This check is necessary to ignore empty and malformed install-referrer URLs in Android
        // while allowing ss://, ssconf:// and invite URLs.
        // TODO: Stop receiving install referrer intents so we can remove this.
        return console.debug('Ignoring intercepted non-Outline url');
      }

      try {
        await this.confirmAddServer(url);
      } catch (err) {
        this.showLocalizedErrorInDefaultPage(err);
      }
    });
  }

  private changeToDefaultPage() {
    this.rootEl.changePage(this.rootEl.DEFAULT_PAGE);
  }

  // Returns the server having serverId, throws if the server cannot be found.
  private getServerByServerId(serverId: string): Server {
    const server = this.serverRepo.getById(serverId);
    if (!server) {
      throw new Error(`could not find server with ID ${serverId}`);
    }
    return server;
  }

  private updateServerListItem(id: string, properties: object) {
    // We have to create a new list so the property change is observed.
    this.rootEl.servers = this.rootEl.servers.map(
      (cardModel: ServerListItem) => {
        if (cardModel.id === id) {
          // Create a new object so the change is reflected in the server_card view.
          return {...cardModel, ...properties} as ServerListItem;
        } else {
          return cardModel;
        }
      }
    );
  }

  private showLocalizedErrorInDefaultPage(err: Error) {
    this.changeToDefaultPage();
    this.showLocalizedError(err);
  }

  private isWindows() {
    return !('cordova' in window);
  }

  private setAppearance(appearance: Appearance) {
    const documentClassList = window.document.documentElement.classList;
    const isSystemDark = matchMedia('(prefers-color-scheme: dark)').matches;

    let applyDarkTheme;

    if (appearance === Appearance.DARK) {
      applyDarkTheme = true;
    } else if (appearance === Appearance.LIGHT) {
      applyDarkTheme = false;
    } else {
      // guard against potentially corrupt value
      appearance = Appearance.SYSTEM;
      applyDarkTheme = isSystemDark;
    }

    if (applyDarkTheme) {
      this.rootEl.darkMode = true;
      documentClassList.add('dark');
    } else {
      this.rootEl.darkMode = false;
      documentClassList.remove('dark');
    }

    this.rootEl.selectedAppearance = appearance;
  }

  //#region API Management methods

  private configureApi(event: CustomEvent) {
    const {apiUrl, apiPassword} = event.detail;
    this.vpnApi.setApiConfig(apiUrl, apiPassword);
    this.rootEl.showToast(this.localize('api-configured'));
    // Store API configuration in settings for persistence
    this.settings.set(SettingsKey.API_URL, apiUrl);
    this.settings.set(SettingsKey.API_PASSWORD, apiPassword);
    // Update stored values in the UI
    this.rootEl.storedApiUrl = apiUrl;
    this.rootEl.storedApiPassword = apiPassword;
  }

  private async fetchApiServers(_event: CustomEvent) {
    try {
      this.rootEl.showToast(this.localize('fetching-servers'));
      const response = await this.vpnApi.fetchServers();

      if (response.status !== 200) {
        throw new Error(response.message || 'Failed to fetch servers');
      }

      if (response.data && response.data.length > 0) {
        let successfulAdds = 0;

        // Add each server from the API response
        for (const serverData of response.data) {
          try {
            const accessKey = serverData.server_link;
            // Validate that it's a proper Outline access key before adding
            if (isOutlineAccessKey(accessKey)) {
              await this.serverRepo.add(accessKey);
              successfulAdds++;
            } else {
              console.warn(
                `Invalid access key format for server ${serverData.row_id}: ${accessKey}`
              );
            }
          } catch (error) {
            console.warn(
              `Failed to add server ${serverData.row_id} with access key ${serverData.server_link}:`,
              error
            );
          }
        }

        if (successfulAdds > 0) {
          this.rootEl.showToast(
            this.localize('servers-fetched', 'count', String(successfulAdds))
          );
        } else {
          this.rootEl.showToast(this.localize('no-valid-servers-added'));
        }
      } else {
        this.rootEl.showToast(this.localize('no-servers-available'));
      }
    } catch (error) {
      this.showLocalizedError(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  private async testServerSpeed(event: CustomEvent) {
    const {serverId} = event.detail;

    // Prevent concurrent testing of the same server
    if (this.serversCurrentlyTesting.has(serverId)) {
      return;
    }

    try {
      const server = this.getServerByServerId(serverId);

      // Mark server as testing and update UI
      this.serversCurrentlyTesting.add(serverId);
      this.updateServerListItem(serverId, {
        isTesting: true,
      });

      // Check if server is already connected
      const wasConnected = await server.checkRunning();
      let shouldDisconnect = false;

      try {
        // If server is not connected, connect it first
        if (!wasConnected) {
          console.debug(`Connecting to server ${serverId} for speed test`);
          await server.connect();
          shouldDisconnect = true;

          // Wait a moment for connection to stabilize
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Now test connectivity through the connected server
        const result = await this.vpnApi.testConnectivity();
        result.serverId = serverId;

        this.serverTestResults.set(serverId, result);

        // Update the server list item with test results
        this.updateServerListItem(serverId, {
          responseTime: result.responseTime,
          bandwidth: result.bandwidth,
          speedTestSuccess: result.success,
          speedTestError: result.error,
          isTesting: false,
        });
      } finally {
        // Disconnect if we connected the server ourselves
        if (shouldDisconnect) {
          try {
            console.debug(
              `Disconnecting from server ${serverId} after speed test`
            );
            await server.disconnect();
          } catch (disconnectError) {
            console.warn(
              `Failed to disconnect after speed test: ${disconnectError}`
            );
          }
        }
      }
    } catch (error) {
      // Ensure we clear the testing state even on error
      this.updateServerListItem(serverId, {
        isTesting: false,
      });

      this.showLocalizedError(
        error instanceof Error ? error : new Error(String(error))
      );
    } finally {
      // Always remove from testing set
      this.serversCurrentlyTesting.delete(serverId);
    }
  }

  private async testAllServers(_event: CustomEvent) {
    try {
      const servers = this.serverRepo.getAll();
      if (servers.length === 0) {
        this.rootEl.showToast(this.localize('no-servers-to-test'));
        return;
      }

      // Mark all servers as testing
      servers.forEach(server => {
        if (!this.serversCurrentlyTesting.has(server.id)) {
          this.serversCurrentlyTesting.add(server.id);
          this.updateServerListItem(server.id, {
            isTesting: true,
          });
        }
      });

      this.rootEl.showToast(this.localize('testing-all-servers'));

      const results: ServerTestResult[] = [];

      // Test servers sequentially to avoid overwhelming the network
      // and to ensure proper connect/disconnect cycles
      for (const server of servers) {
        try {
          // Check if server is already connected
          const wasConnected = await server.checkRunning();
          let shouldDisconnect = false;

          try {
            // If server is not connected, connect it first
            if (!wasConnected) {
              console.debug(`Connecting to server ${server.id} for speed test`);
              await server.connect();
              shouldDisconnect = true;

              // Wait a moment for connection to stabilize
              await new Promise(resolve => setTimeout(resolve, 1000));
            }

            // Now test connectivity through the connected server
            const result = await this.vpnApi.testConnectivity();
            result.serverId = server.id;
            results.push(result);

            this.serverTestResults.set(server.id, result);

            // Update UI with result
            this.updateServerListItem(result.serverId, {
              responseTime: result.responseTime,
              bandwidth: result.bandwidth,
              speedTestSuccess: result.success,
              speedTestError: result.error,
              isTesting: false,
            });
          } finally {
            // Disconnect if we connected the server ourselves
            if (shouldDisconnect) {
              try {
                console.debug(
                  `Disconnecting from server ${server.id} after speed test`
                );
                await server.disconnect();
              } catch (disconnectError) {
                console.warn(
                  `Failed to disconnect after speed test: ${disconnectError}`
                );
              }
            }
          }
        } catch (error) {
          // Create failed result for this server
          const failedResult: ServerTestResult = {
            serverId: server.id,
            responseTime: 0,
            bandwidth: 0,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
          results.push(failedResult);

          this.updateServerListItem(server.id, {
            responseTime: 0,
            bandwidth: 0,
            speedTestSuccess: false,
            speedTestError: failedResult.error,
            isTesting: false,
          });
        }

        this.serversCurrentlyTesting.delete(server.id);
      }

      const successfulTests = results.filter(
        (r: ServerTestResult) => r.success
      ).length;
      this.rootEl.showToast(
        this.localize(
          'all-speed-tests-complete',
          'successful',
          String(successfulTests),
          'total',
          String(results.length)
        )
      );

      // Log the results for potential API submission
      const logs = results.map((result: ServerTestResult) => ({
        type: 'speed_test',
        isp: 'unknown', // Could be enhanced to detect ISP
        success: result.success,
      }));

      try {
        await this.vpnApi.storeLogs(logs);
      } catch (error) {
        console.warn('Failed to store test logs:', error);
      }
    } catch (error) {
      // Clear testing state for all servers on error
      this.serversCurrentlyTesting.forEach(serverId => {
        this.updateServerListItem(serverId, {
          isTesting: false,
        });
      });
      this.serversCurrentlyTesting.clear();

      this.showLocalizedError(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  //#endregion API Management methods
}
