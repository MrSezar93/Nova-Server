/** Deterministic fixtures used across the test suite. */

import { renderConfig, type ConfigFormat, type WgProfile } from "../src/lib/wg";

export function buildProfileFixture(): WgProfile {
  return {
    privateKey: "WCZJ1DCyQ9o3nJmY0TQvNtYCJN2u4aJdT8nB8GZ2XkI=",
    addressV4: "172.16.0.2",
    addressV6: "2606:4700:110::2",
    peerPublicKey: "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=",
    endpoint: { host: "engage.cloudflareclient.com", port: 2408 },
    dns: ["1.1.1.1", "1.0.0.1", "2606:4700:4700::1111", "2606:4700:4700::1001"],
    mtu: 1280,
    keepalive: 25,
    allowedIps: ["0.0.0.0/0", "::/0"],
    reserved: [0x52, 0xef, 0x1f],
  };
}

export function configFor(format: ConfigFormat, profile: WgProfile): string {
  return renderConfig(format, profile, "test-client");
}

export const WG_CONF_SAMPLE = `[Interface]
PrivateKey = WCZJ1DCyQ9o3nJmY0TQvNtYCJN2u4aJdT8nB8GZ2XkI=
Address = 172.16.0.2/32, 2606:4700:110:8a36:df92:102a:9602:fa18/128
DNS = 1.1.1.1
MTU = 1280

[Peer]
PublicKey = bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 162.159.192.1:2408
PersistentKeepalive = 25
`;

export const WGCF_TOML_SAMPLE = `# wgcf-account.toml
access_token = 'aaa-bbb'
device_id = 'cccc-dddd'
license_key = '12345678-abcdefgh'
private_key = 'WCZJ1DCyQ9o3nJmY0TQvNtYCJN2u4aJdT8nB8GZ2XkI='
`;

export const WARP_JSON_SAMPLE = JSON.stringify({
  id: "device-abc",
  token: "secret-token",
  private_key: "WCZJ1DCyQ9o3nJmY0TQvNtYCJN2u4aJdT8nB8GZ2XkI=",
  config: {
    client_id: "Uu8fHg==",
    interface: { addresses: { v4: "172.16.0.2/32", v6: "2606:4700:110::2/128" } },
    peers: [
      {
        public_key: "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=",
        endpoint: { host: "engage.cloudflareclient.com", ports: [2408] },
      },
    ],
  },
});
