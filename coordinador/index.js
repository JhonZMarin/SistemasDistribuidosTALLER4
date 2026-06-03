require("dotenv").config();

const { 
  COORDINATOR_ID, PUBLIC_PORT, PEER_PORT, 
  HEARTBEAT_INTERVAL_MS, PEER_DISCOVERY_INTERVAL_MS, PEER_SNAPSHOT_INTERVAL_MS 
} = require("./config");
const { publicServer, peerServer } = require("./routes");
const mesh = require("./mesh");

// Start Mesh background intervals
setInterval(mesh.sendHeartbeat, HEARTBEAT_INTERVAL_MS).unref();
setInterval(mesh.refreshPeerDirectory, PEER_DISCOVERY_INTERVAL_MS).unref();
setInterval(mesh.broadcastSnapshotToPeers, PEER_SNAPSHOT_INTERVAL_MS).unref();

// Start Servers
publicServer.listen(PUBLIC_PORT, async () => {
  console.log(`Coordinator ${COORDINATOR_ID} public WS listening on http://localhost:${PUBLIC_PORT}`);
  await mesh.sendHeartbeat();
});

peerServer.listen(PEER_PORT, async () => {
  console.log(`Coordinator ${COORDINATOR_ID} peer WS listening on http://localhost:${PEER_PORT}`);
  await mesh.refreshPeerDirectory();
});
