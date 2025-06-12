// Copyright 2024 The Outline Authors
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

package outline

import (
	"context"
	"time"

	"github.com/Jigsaw-Code/outline-apps/client/go/outline/connectivity"
	"github.com/Jigsaw-Code/outline-apps/client/go/outline/platerrors"
)

// TCPAndUDPConnectivityResult represents the result of TCP and UDP connectivity checks.
//
// We use a struct instead of a tuple to preserve a strongly typed error that gobind recognizes.
type TCPAndUDPConnectivityResult struct {
	TCPError, UDPError *platerrors.PlatformError
}

// CheckTCPAndUDPConnectivity checks if a [Client] can relay TCP and UDP traffic.
//
// It parallelizes the execution of TCP and UDP checks, and returns a [TCPAndUDPConnectivityResult]
// containing a TCP error and a UDP error.
// If the connectivity check was successful, the corresponding error field will be nil.
func CheckTCPAndUDPConnectivity(client *Client) *TCPAndUDPConnectivityResult {
	tcpErr, udpErr := connectivity.CheckTCPAndUDPConnectivity(client, client)
	return &TCPAndUDPConnectivityResult{
		TCPError: platerrors.ToPlatformError(tcpErr),
		UDPError: platerrors.ToPlatformError(udpErr),
	}
}

// ComprehensiveTestResult represents the result of comprehensive connectivity and bandwidth testing.
//
// We use a struct to preserve strongly typed errors that gobind recognizes and provide
// detailed bandwidth and latency measurements.
type ComprehensiveTestResult struct {
	// Connectivity results
	TCPError, UDPError *platerrors.PlatformError

	// Bandwidth results
	DownloadSpeedKBps int64 // Download speed in KB/s
	UploadSpeedKBps   int64 // Upload speed in KB/s
	LatencyMs         int64 // Round-trip latency in milliseconds
	BandwidthError    *platerrors.PlatformError
}

// PerformComprehensiveTest performs both connectivity and bandwidth testing.
//
// It first checks TCP and UDP connectivity, then performs bandwidth and latency tests
// if the connectivity checks pass. This provides a complete picture of the proxy's performance.
func PerformComprehensiveTest(client *Client) *ComprehensiveTestResult {
	result := &ComprehensiveTestResult{}

	// First perform connectivity tests
	connectivityResult := CheckTCPAndUDPConnectivity(client)
	result.TCPError = connectivityResult.TCPError
	result.UDPError = connectivityResult.UDPError

	// Only perform bandwidth tests if TCP connectivity succeeds
	if result.TCPError == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		bandwidthResult := client.PerformBandwidthTest(ctx)
		if bandwidthResult.Error != nil {
			result.BandwidthError = bandwidthResult.Error
			// Set default values on bandwidth test failure
			result.DownloadSpeedKBps = -1
			result.UploadSpeedKBps = -1
			result.LatencyMs = -1
		} else {
			result.DownloadSpeedKBps = bandwidthResult.DownloadSpeedKBps
			result.UploadSpeedKBps = bandwidthResult.UploadSpeedKBps
			result.LatencyMs = bandwidthResult.LatencyMs
		}
	} else {
		// TCP failed, so skip bandwidth tests
		result.DownloadSpeedKBps = -1
		result.UploadSpeedKBps = -1
		result.LatencyMs = -1
	}

	return result
}
