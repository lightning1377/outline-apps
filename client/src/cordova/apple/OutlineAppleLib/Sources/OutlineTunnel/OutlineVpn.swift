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

import CocoaLumberjackSwift
import NetworkExtension
import OutlineError

// Manages the system's VPN tunnel through the VpnExtension process.
@objcMembers
public class OutlineVpn: NSObject {
  public static let shared = OutlineVpn()
  private static let kVpnExtensionBundleId = "\(Bundle.main.bundleIdentifier!).VpnExtension"

  public typealias VpnStatusObserver = (NEVPNStatus, String) -> Void

  private var vpnStatusObserver: VpnStatusObserver?

  private enum Action {
    static let start = "start"
    static let restart = "restart"
    static let stop = "stop"
    static let getTunnelId = "getTunnelId"
    static let testConnectivity = "testConnectivity"
  }

  private enum ConfigKey {
    static let tunnelId = "id"
    static let transport = "transport"
  }

  override private init() {
    super.init()
    // Register observer for VPN changes.
    // Remove self to guard against receiving duplicate notifications due to page reloads.
    NotificationCenter.default.removeObserver(self, name: .NEVPNStatusDidChange, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(self.vpnStatusChanged),
                                           name: .NEVPNStatusDidChange, object: nil)
  }

  // MARK: - Interface

  /** Starts a VPN tunnel as specified in the OutlineTunnel object. */
  public func start(_ tunnelId: String, named name: String?, withTransport transportConfig: String) async throws {
    if let manager = await getTunnelManager(), isActiveSession(manager.connection) {
      DDLogDebug("Stoppping active session before starting new one")
      await stopSession(manager)
    }

    let manager: NETunnelProviderManager
    do {
      manager = try await setupVpn(withId: tunnelId, named: name ?? "Outline Server", withTransport: transportConfig)
    } catch {
      DDLogError("Failed to setup VPN: \(error.localizedDescription)")
      throw OutlineError.vpnPermissionNotGranted(cause: error)
    }
    let session = manager.connection as! NETunnelProviderSession

    // Register observer for start process completion.
    class TokenHolder {
      var token: NSObjectProtocol?
    }
    let tokenHolder = TokenHolder()
      let startDone = Task {
          await withCheckedContinuation { continuation in
              tokenHolder.token = NotificationCenter.default.addObserver(forName: .NEVPNStatusDidChange, object: manager.connection, queue: nil) { notification in
                  // The notification object is always the session, so we can rely on that to not be nil.
                  guard let connection = notification.object as? NETunnelProviderSession else {
                      DDLogDebug("Failed to cast notification.object to NETunnelProviderSession")
                      return
                  }
                  
                  let status = connection.status
                  DDLogDebug("OutlineVpn.start got status \(String(describing: status)), notification: \(String(describing: notification))")
                  // The observer may be triggered multiple times, but we only remove it when we reach an end state.
                  // A successful connection will go through .connecting -> .disconnected
                  // A failed connection will go through .connecting -> .disconnecting -> .disconnected
                  // An .invalid event may happen if the configuration is modified and ends in an invalid state.
                  if status == .connected || status == .disconnected || status == .invalid {
                      DDLogDebug("Tunnel start done.")
                      if let token = tokenHolder.token {
                          NotificationCenter.default.removeObserver(token, name: .NEVPNStatusDidChange, object: connection)
                      }
                      continuation.resume()
                  }
              }
          }
      }

    // Start the session.
    do {
      DDLogDebug("Calling NETunnelProviderSession.startTunnel([:])")
      try session.startTunnel(options: [:])
      DDLogDebug("NETunnelProviderSession.startTunnel() returned")
    } catch {
      DDLogError("Failed to start VPN: \(error.localizedDescription)")
      throw OutlineError.setupSystemVPNFailed(cause: error)
    }

    // Wait for it to be done.
    await startDone.value

    switch manager.connection.status {
    case .connected:
      break
    case .disconnected, .invalid:
      guard let err = await fetchExtensionLastDisconnectError(session) else {
        throw OutlineError.internalError(message: "unexpected nil disconnect error")
      }
      throw err
    default:
      // This shouldn't happen.
      throw OutlineError.internalError(message: "unexpected connection status")
    }

    // Set an on-demand rule to connect to any available network to implement auto-connect on boot
    do { try await manager.loadFromPreferences() }
    catch {
      DDLogWarn("OutlineVpn.start: Failed to reload preferences: \(error.localizedDescription)")
    }
    let connectRule = NEOnDemandRuleConnect()
    connectRule.interfaceTypeMatch = .any
    manager.onDemandRules = [connectRule]
    do { try await manager.saveToPreferences() }
    catch {
      DDLogWarn("OutlineVpn.start: Failed to save on-demand preference change: \(error.localizedDescription)")
    }
  }

  /** Tears down the VPN if the tunnel with id |tunnelId| is active. */
  public func stop(_ tunnelId: String) async {
    guard let manager = await getTunnelManager(),
          getTunnelId(forManager: manager) == tunnelId,
          isActiveSession(manager.connection) else {
      DDLogWarn("Trying to stop tunnel \(tunnelId) that is not running")
      return
    }
    await stopSession(manager)
  }

  /** Calls |observer| when the VPN's status changes. */
  public func onVpnStatusChange(_ observer: @escaping(VpnStatusObserver)) {
    vpnStatusObserver = observer
  }

  
  /** Returns whether |tunnelId| is actively proxying through the VPN. */
  public func isActive(_ tunnelId: String?) async -> Bool {
    guard tunnelId != nil, let manager = await getTunnelManager() else {
      return false
    }
    return getTunnelId(forManager: manager) == tunnelId && isActiveSession(manager.connection)
  }

  /** Performs comprehensive test including real bandwidth measurement without establishing VPN routing. */
  public func performComprehensiveTest(withTransport transportConfig: String) async throws -> [String: Any] {
    DDLogInfo("Performing comprehensive test without VPN routing")
    
    // Try to use existing VPN extension if available, otherwise create a temporary one
    var manager: NETunnelProviderManager?
    let shouldCleanup: Bool
    
    if let existingManager = await getTunnelManager() {
      manager = existingManager
      shouldCleanup = false
      DDLogDebug("Using existing VPN manager for comprehensive test")
    } else {
      // Create a temporary VPN configuration just for testing
      do {
        manager = try await setupTestVpn(withTransport: transportConfig)
        shouldCleanup = true
        DDLogDebug("Created temporary VPN manager for comprehensive test")
      } catch {
        DDLogError("Failed to setup test VPN configuration: \(error.localizedDescription)")
        throw OutlineError.vpnPermissionNotGranted(cause: error)
      }
    }
    
    guard let vpnManager = manager else {
      throw OutlineError.internalError(message: "Failed to get VPN manager for testing")
    }
    
    do {
      let testResults = try await performComprehensiveTestViaExtension(manager: vpnManager, transportConfig: transportConfig)
      
      // Clean up temporary configuration if we created one
      if shouldCleanup {
        try? await vpnManager.removeFromPreferences()
      }
      
      return testResults
    } catch {
      // Clean up on error
      if shouldCleanup {
        try? await vpnManager.removeFromPreferences()
      }
      throw error
    }
  }

  // MARK: - Helpers

  public func stopActiveVpn() async {
    if let manager = await getTunnelManager() {
      await stopSession(manager)
    }
  }

  // Creates a temporary VPN configuration for testing purposes only
  private func setupTestVpn(withTransport transportConfig: String) async throws -> NETunnelProviderManager {
    let manager = NETunnelProviderManager()
    manager.localizedDescription = "Outline Test Configuration"
    manager.onDemandRules = nil // Disable on-demand for testing
    
    let config = NETunnelProviderProtocol()
    config.serverAddress = "Outline-Test"
    config.providerBundleIdentifier = OutlineVpn.kVpnExtensionBundleId
    config.providerConfiguration = [
      ConfigKey.tunnelId: "test-\(UUID().uuidString)",
      ConfigKey.transport: transportConfig
    ]
    manager.protocolConfiguration = config
    manager.isEnabled = true
    
    try await manager.saveToPreferences()
    try await manager.loadFromPreferences()
    return manager
  }

  // Performs comprehensive test via VPN extension IPC
  private func performComprehensiveTestViaExtension(manager: NETunnelProviderManager, transportConfig: String) async throws -> [String: Any] {
    // We need a session to communicate with the extension
    let session = manager.connection as! NETunnelProviderSession
    
    // Prepare the IPC request with transport config inline
    let ipcMessage = "comprehensiveTest:\(transportConfig)"
    guard let requestData = ipcMessage.data(using: .utf8) else {
      throw OutlineError.internalError(message: "Failed to create IPC request data")
    }
    
    return try await withCheckedThrowingContinuation { continuation in
      do {
        DDLogDebug("Sending comprehensive test request to VPN extension")
        try session.sendProviderMessage(requestData) { responseData in
          guard let data = responseData else {
            DDLogError("Extension comprehensive test returned nil")
            continuation.resume(throwing: OutlineError.internalError(message: "Extension test returned no data"))
            return
          }
          
          do {
            // Decode the response using the proper data structure
            let testResult = try PropertyListDecoder().decode(ComprehensiveTestResult.self, from: data)
            DDLogInfo("Extension comprehensive test completed: TCP=\(testResult.tcpSuccess), UDP=\(testResult.udpSuccess), Download=\(testResult.downloadSpeedKBps) KB/s, Upload=\(testResult.uploadSpeedKBps) KB/s, Latency=\(testResult.latencyMs) ms")
            
            // Convert to dictionary for return
            let resultDict: [String: Any] = [
              "tcpSuccess": testResult.tcpSuccess,
              "udpSuccess": testResult.udpSuccess,
              "connectivitySuccess": testResult.connectivitySuccess,
              "downloadSpeedKBps": testResult.downloadSpeedKBps,
              "uploadSpeedKBps": testResult.uploadSpeedKBps,
              "latencyMs": testResult.latencyMs,
              "downloadTestSuccess": testResult.downloadTestSuccess,
              "uploadTestSuccess": testResult.uploadTestSuccess,
              "tcpError": testResult.tcpError as Any,
              "udpError": testResult.udpError as Any,
              "downloadTestError": testResult.downloadTestError as Any,
              "uploadTestError": testResult.uploadTestError as Any
            ]
            
            continuation.resume(returning: resultDict)
          } catch {
            DDLogError("Failed to decode extension test results: \(error)")
            continuation.resume(throwing: error)
          }
        }
      } catch {
        DDLogError("Failed to send test request to extension: \(error)")
        continuation.resume(throwing: error)
      }
    }
  }

  // Adds a VPN configuration to the user preferences if no Outline profile is present. Otherwise
  // enables the existing configuration.
  private func setupVpn(withId id:String, named name:String, withTransport transportConfig: String) async throws -> NETunnelProviderManager {
    let managers = try await NETunnelProviderManager.loadAllFromPreferences()
    var manager: NETunnelProviderManager!
    if managers.count > 0 {
      manager = managers.first
    } else {
      manager = NETunnelProviderManager()
    }

    manager.localizedDescription = name
    // Make sure on-demand is disable, so it doesn't retry on start failure.
    manager.onDemandRules = nil

    // Configure the protocol.
    let config = NETunnelProviderProtocol()
    // TODO(fortuna): set to something meaningful if we can.
    config.serverAddress = "Outline"
    config.providerBundleIdentifier = OutlineVpn.kVpnExtensionBundleId
    config.providerConfiguration = [
      ConfigKey.tunnelId: id,
      ConfigKey.transport: transportConfig
    ]
    manager.protocolConfiguration = config

    // A VPN configuration must be enabled before it can be used to bring up a VPN tunnel.
    manager.isEnabled = true

    try await manager.saveToPreferences()
    // Workaround for https://forums.developer.apple.com/thread/25928
    try await manager.loadFromPreferences()
    return manager
  }

  // Receives NEVPNStatusDidChange notifications. Calls onTunnelStatusChange for the active
  // tunnel.
  func vpnStatusChanged(notification: NSNotification) {
    DDLogDebug("OutlineVpn.vpnStatusChanged: \(String(describing: notification))")
    guard let session = notification.object as? NETunnelProviderSession else {
      DDLogDebug("Bad session in OutlineVpn.vpnStatusChanged")
      return
    }
    guard let manager = session.manager as? NETunnelProviderManager else {
      // For some reason we get spurious notifications with connecting and disconnecting states
      DDLogDebug("Bad manager in OutlineVpn.vpnStatusChanged session=\(String(describing:session)) status=\(String(describing: session.status))")
      return
    }
    guard let protoConfig = manager.protocolConfiguration as? NETunnelProviderProtocol,
          let tunnelId = protoConfig.providerConfiguration?["id"] as? String else {
      DDLogWarn("Bad VPN Config: \(String(describing: session.manager.protocolConfiguration))")
      return
    }
    DDLogDebug("OutlineVpn received status change for \(tunnelId): \(String(describing: session.status))")
    if isActiveSession(session) {
      Task {
        await setConnectVpnOnDemand(manager, true)
      }
    }
    self.vpnStatusObserver?(session.status, tunnelId)
  }
}

// Retrieves the application's tunnel provider manager from the VPN preferences.
private func getTunnelManager() async -> NETunnelProviderManager? {
  do {
    let managers: [NETunnelProviderManager] = try await NETunnelProviderManager.loadAllFromPreferences()
    guard managers.count > 0 else {
      DDLogDebug("OutlineVpn.getTunnelManager: No managers found")
      return nil
    }
    return managers.first
  } catch {
    DDLogError("Failed to get tunnel manager: \(error.localizedDescription)")
    return nil
  }
}

private func getTunnelId(forManager manager:NETunnelProviderManager?) -> String? {
  let protoConfig = manager?.protocolConfiguration as? NETunnelProviderProtocol
  return protoConfig?.providerConfiguration?["id"] as? String
}

private func isActiveSession(_ session: NEVPNConnection?) -> Bool {
  let vpnStatus = session?.status
  return vpnStatus == .connected || vpnStatus == .connecting || vpnStatus == .reasserting
}

private func stopSession(_ manager:NETunnelProviderManager) async {
  do {
    try await manager.loadFromPreferences()
    await setConnectVpnOnDemand(manager, false) // Disable on demand so the VPN does not connect automatically.
    manager.connection.stopVPNTunnel()
    // Wait for stop to be completed.
    class TokenHolder {
      var token: NSObjectProtocol?
    }
    let tokenHolder = TokenHolder()
    await withCheckedContinuation { continuation in
      tokenHolder.token = NotificationCenter.default.addObserver(forName: .NEVPNStatusDidChange, object: manager.connection, queue: nil) { notification in
        if manager.connection.status == .disconnected {
          DDLogDebug("Tunnel stopped. Ready to start again.")
          if let token = tokenHolder.token {
            NotificationCenter.default.removeObserver(token, name: .NEVPNStatusDidChange, object: manager.connection)
          }
          continuation.resume()
        }
      }
    }
  } catch {
    DDLogWarn("Failed to stop VPN")
  }
}

private func setConnectVpnOnDemand(_ manager: NETunnelProviderManager?, _ enabled: Bool) async {
  do {
    try await manager?.loadFromPreferences()
    manager?.isOnDemandEnabled = enabled
    try await manager?.saveToPreferences()
  } catch {
    DDLogError("Failed to set VPN on demand to \(enabled): \(error)")
    return
  }
}


// MARK: - Fetch last disconnect error

// TODO: Remove this code once we only support newer systems (macOS 13.0+, iOS 16.0+)
// mimics fetchLastDisconnectErrorWithCompletionHandler on older systems
// See: "fetch last disconnect error" section in the VPN extension code.

private enum ExtensionIPC {
  static let fetchLastDetailedJsonError = "fetchLastDisconnectDetailedJsonError"
}

/// Keep it in sync with the data type defined in PacketTunnelProvider.Swift
/// Also keep in mind that we will always use PropertyListEncoder and PropertyListDecoder to marshal this data.
private struct LastErrorIPCData: Decodable {
  let errorCode: String
  let errorJson: String
}

/// Data structure for comprehensive test results from VPN extension
private struct ComprehensiveTestResult: Decodable {
  let tcpSuccess: Bool
  let udpSuccess: Bool
  let connectivitySuccess: Bool
  let downloadSpeedKBps: Int
  let uploadSpeedKBps: Int
  let latencyMs: Int
  let downloadTestSuccess: Bool
  let uploadTestSuccess: Bool
  let tcpError: String?
  let udpError: String?
  let downloadTestError: String?
  let uploadTestError: String?
}

// Fetches the most recent error that caused the VPN extension to disconnect.
// If no error, it returns nil. Otherwise, it returns a description of the error.
private func fetchExtensionLastDisconnectError(_ session: NETunnelProviderSession) async -> Error? {
  do {
    guard let rpcNameData = ExtensionIPC.fetchLastDetailedJsonError.data(using: .utf8) else {
      return OutlineError.internalError(message: "IPC fetchLastDisconnectError failed")
    }
    return try await withCheckedThrowingContinuation { continuation in
      do {
        DDLogDebug("Calling Extension IPC: \(ExtensionIPC.fetchLastDetailedJsonError)")
        try session.sendProviderMessage(rpcNameData) { data in
          guard let response = data else {
            DDLogDebug("Extension IPC returned with nil error")
            return continuation.resume(returning: nil)
          }
          do {
            let lastError = try PropertyListDecoder().decode(LastErrorIPCData.self, from: response)
            DDLogDebug("Extension IPC returned with \(lastError)")
            continuation.resume(returning: OutlineError.detailedJsonError(code: lastError.errorCode,
                                                                          json: lastError.errorJson))
          } catch {
            continuation.resume(throwing: error)
          }
        }
      } catch {
        continuation.resume(throwing: error)
      }
    }
  } catch {
    DDLogError("Failed to invoke VPN Extension IPC: \(error)")
    return OutlineError.internalError(
      message: "IPC fetchLastDisconnectError failed: \(error.localizedDescription)"
    )
  }
}
