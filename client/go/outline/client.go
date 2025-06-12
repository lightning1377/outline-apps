// Copyright 2023 The Outline Authors
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
	"crypto/rand"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/Jigsaw-Code/outline-apps/client/go/outline/config"
	"github.com/Jigsaw-Code/outline-apps/client/go/outline/platerrors"
	"github.com/Jigsaw-Code/outline-sdk/transport"
	"github.com/goccy/go-yaml"
)

// Client provides a transparent container for [transport.StreamDialer] and [transport.PacketListener]
// that is exportable (as an opaque object) via gobind.
// It's used by the connectivity test and the tun2socks handlers.
// TODO: Rename to Transport. Needs to update per-platform code.
type Client struct {
	sd *config.Dialer[transport.StreamConn]
	pl *config.PacketListener
}

func (c *Client) DialStream(ctx context.Context, address string) (transport.StreamConn, error) {
	return c.sd.Dial(ctx, address)
}

func (c *Client) ListenPacket(ctx context.Context) (net.PacketConn, error) {
	return c.pl.ListenPacket(ctx)
}

// BandwidthTestResult represents the results of bandwidth and latency testing
type BandwidthTestResult struct {
	DownloadSpeedKBps int64 // Download speed in KB/s
	UploadSpeedKBps   int64 // Upload speed in KB/s
	LatencyMs         int64 // Round-trip latency in milliseconds
	Error             *platerrors.PlatformError
}

// TestLatency measures the round-trip time to a test server through the proxy
func (c *Client) TestLatency(ctx context.Context, testURL string) int64 {
	start := time.Now()

	// Create HTTP client that uses our proxy transport
	httpClient := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return c.sd.Dial(ctx, addr)
			},
		},
		Timeout: 10 * time.Second,
	}

	resp, err := httpClient.Head(testURL)
	if err != nil {
		return -1 // Error occurred
	}
	defer resp.Body.Close()

	return time.Since(start).Milliseconds()
}

// TestDownloadSpeed measures download speed by downloading data through the proxy
func (c *Client) TestDownloadSpeed(ctx context.Context, testURL string, durationSeconds int) int64 {
	// Create HTTP client that uses our proxy transport
	httpClient := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return c.sd.Dial(ctx, addr)
			},
		},
		Timeout: time.Duration(durationSeconds+5) * time.Second,
	}

	start := time.Now()
	resp, err := httpClient.Get(testURL)
	if err != nil {
		return -1
	}
	defer resp.Body.Close()

	var totalBytes int64
	buffer := make([]byte, 128*1024) // Increased to 128KB buffer for better throughput
	testDuration := time.Duration(durationSeconds) * time.Second

	for time.Since(start) < testDuration {
		n, err := resp.Body.Read(buffer)
		if err != nil && err != io.EOF {
			break
		}
		totalBytes += int64(n)
		if err == io.EOF {
			break
		}
	}

	actualDuration := time.Since(start)
	if actualDuration.Milliseconds() == 0 {
		return -1
	}

	// Return speed in KB/s
	return totalBytes / int64(actualDuration.Milliseconds()) * 1000 / 1024
}

// TestUploadSpeed measures upload speed by uploading data through the proxy
func (c *Client) TestUploadSpeed(ctx context.Context, testURL string, durationSeconds int) int64 {
	// Create HTTP client that uses our proxy transport
	httpClient := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return c.sd.Dial(ctx, addr)
			},
		},
		Timeout: time.Duration(durationSeconds+5) * time.Second,
	}

	// Create test data
	chunkSize := 256 * 1024 // Increased to 256KB chunks
	data := make([]byte, chunkSize)
	rand.Read(data)

	start := time.Now()
	var totalBytes int64
	testDuration := time.Duration(durationSeconds) * time.Second

	for time.Since(start) < testDuration {
		// Create a new request for each chunk using strings.Reader
		resp, err := httpClient.Post(testURL, "application/octet-stream",
			strings.NewReader(string(data)))

		if err != nil {
			break
		}
		resp.Body.Close()

		totalBytes += int64(chunkSize)

		// Reduced delay to 5ms to allow for higher throughput
		time.Sleep(5 * time.Millisecond)
	}

	actualDuration := time.Since(start)
	if actualDuration.Milliseconds() == 0 {
		return -1
	}

	// Return speed in KB/s
	return totalBytes / int64(actualDuration.Milliseconds()) * 1000 / 1024
}

// PerformBandwidthTest runs comprehensive bandwidth and latency tests
func (c *Client) PerformBandwidthTest(ctx context.Context) *BandwidthTestResult {
	// Use speed.cloudflare.com for testing - it's designed for bandwidth testing
	downloadURL := "https://speed.cloudflare.com/__down?bytes=2097152" // 2MB download
	uploadURL := "https://speed.cloudflare.com/__up"                   // POST endpoint
	latencyURL := "https://speed.cloudflare.com/__ping"                // Simple HEAD request

	result := &BandwidthTestResult{}

	// Test latency (quick test)
	result.LatencyMs = c.TestLatency(ctx, latencyURL)

	// Test download speed (10 seconds)
	result.DownloadSpeedKBps = c.TestDownloadSpeed(ctx, downloadURL, 10)

	// Test upload speed (10 seconds)
	result.UploadSpeedKBps = c.TestUploadSpeed(ctx, uploadURL, 10)

	// Check for any failures
	if result.LatencyMs == -1 || result.DownloadSpeedKBps == -1 || result.UploadSpeedKBps == -1 {
		result.Error = &platerrors.PlatformError{
			Code:    platerrors.InternalError,
			Message: "bandwidth test failed",
		}
	}

	return result
}

// ClientConfig is used to create the Client.
type ClientConfig struct {
	Transport config.ConfigNode
}

// NewClientResult represents the result of [NewClientAndReturnError].
//
// We use a struct instead of a tuple to preserve a strongly typed error that gobind recognizes.
type NewClientResult struct {
	Client *Client
	Error  *platerrors.PlatformError
}

// NewClient creates a new Outline client from a configuration string.
func NewClient(clientConfig string) *NewClientResult {
	tcpDialer := transport.TCPDialer{Dialer: net.Dialer{KeepAlive: -1}}
	udpDialer := transport.UDPDialer{}
	client, err := NewClientWithBaseDialers(clientConfig, &tcpDialer, &udpDialer)
	if err != nil {
		return &NewClientResult{Error: platerrors.ToPlatformError(err)}
	}
	return &NewClientResult{Client: client}
}

func NewClientWithBaseDialers(clientConfigText string, tcpDialer transport.StreamDialer, udpDialer transport.PacketDialer) (*Client, error) {
	var clientConfig ClientConfig
	err := yaml.Unmarshal([]byte(clientConfigText), &clientConfig)
	if err != nil {
		return nil, &platerrors.PlatformError{
			Code:    platerrors.InvalidConfig,
			Message: "config is not valid YAML",
			Cause:   platerrors.ToPlatformError(err),
		}
	}

	transportPair, err := config.NewDefaultTransportProvider(tcpDialer, udpDialer).Parse(context.Background(), clientConfig.Transport)
	if err != nil {
		if errors.Is(err, errors.ErrUnsupported) {
			return nil, &platerrors.PlatformError{
				Code:    platerrors.InvalidConfig,
				Message: "unsupported config",
				Cause:   platerrors.ToPlatformError(err),
			}
		} else {
			return nil, &platerrors.PlatformError{
				Code:    platerrors.InvalidConfig,
				Message: "failed to create transport",
				Cause:   platerrors.ToPlatformError(err),
			}
		}
	}

	// Make sure the transport is not proxyless for now.
	if transportPair.StreamDialer.ConnType == config.ConnTypeDirect {
		return nil, &platerrors.PlatformError{
			Code:    platerrors.InvalidConfig,
			Message: "transport must tunnel TCP traffic",
		}
	}
	if transportPair.PacketListener.ConnType == config.ConnTypeDirect {
		return nil, &platerrors.PlatformError{
			Code:    platerrors.InvalidConfig,
			Message: "transport must tunnel UDP traffic",
		}
	}

	return &Client{sd: transportPair.StreamDialer, pl: transportPair.PacketListener}, nil
}
