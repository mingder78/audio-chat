import { useState, useCallback, useEffect } from "react";
import { startLibp2pNode } from "../services/libp2p-services";
import { useLibp2p } from "../contexts/Libp2pContext";
import "../App.css";

function CreatePeer() {
  const [localPeer, setLocalPeer] = useState("");
  const { libp2pState, setLibp2pState } = useLibp2p();
  const [libp2pInitializing, setLibp2pInitializing] = useState(false);
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: "",
    severity: "info",
  });

  const showMsg = (message, severity = "info") => {
    setSnackbar({ open: true, message, severity });
  };

  const ensureLibp2p = useCallback(async () => {
    if (libp2pState) return libp2pState;
    setLibp2pInitializing(true);
    try {
      const lp = await startLibp2pNode();
      const newPeer = lp.peerId.toString();
      setLocalPeer(newPeer);
      setLibp2pState(lp);
      showMsg("Libp2p connected successfully", "success");
      return lp;
    } catch (e) {
      console.error("[STREAM] Failed to initialize libp2p:", e);
      showMsg("Failed to connect to libp2p network", "error");
      return null;
    } finally {
      setLibp2pInitializing(false);
    }
  }, [libp2pState, setLibp2pState, setLibp2pInitializing]);

  // Auto-initialize libp2p on component mount
  useEffect(() => {
    if (!libp2pState && !libp2pInitializing) {
      console.log("[STREAM] Auto-initializing libp2p...");
      ensureLibp2p();
    }
  }, [libp2pState, libp2pInitializing, ensureLibp2p]); // Only run once on mount

  return (
    <>
      <div>
        <p>Local Peer:🚀 {localPeer}</p>
      </div>
    </>
  );
}

export default CreatePeer;
