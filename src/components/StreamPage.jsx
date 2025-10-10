import { useState, useCallback, useEffect, useRef } from "react";
import { startLibp2pNode } from "../services/libp2p-services";
import { useLibp2p } from "../contexts/Libp2pContext";
import "../App.css";
import { Switch } from "@headlessui/react";
// we send raw binary frames over the protocol; no base64 conversion needed
const base64ToBuf = (b64) => {
  try {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch (e) {
    return null;
  }
};

// helper to convert ArrayBuffer/Uint8Array to base64 string for pubsub init replay
const bufToBase64 = (buf) => {
  try {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  } catch (e) {
    return null;
  }
};

// PubSub topic prefix
const STREAM_TOPIC_PREFIX = "cyberfly.video.stream.";

// direct protocol for binary frames (init + chunks)
const VIDEO_PROTOCOL = "/cyberfly/video/1.0.0";

// WebRTC signaling protocol
const WEBRTC_SIGNAL_PROTOCOL = "/cyberfly/webrtc-signal/1.0.0";

const BOOTSTRAP_MULTIADDRS = [
  // prefer secure websocket for better mobile compatibility
  "/dns4/node.cyberfly.io/tcp/31002/wss/p2p/12D3KooWA8mwP9wGUc65abVDMuYccaAMAkXhKUqpwKUZSN5McDrw",
];

// WebRTC configuration
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
  iceCandidatePoolSize: 10,
};

function StreamPage() {
  const [localPeer, setLocalPeer] = useState("");
  const [channel, setChannel] = useState("main");
  const topicName = `${STREAM_TOPIC_PREFIX}${channel}`; // Add topicName definition
  const [broadcasting, setBroadcasting] = useState(false);
  const [subscribed, setSubscribed] = useState(false);

  const { libp2pState, setLibp2pState } = useLibp2p();
  const [libp2pInitializing, setLibp2pInitializing] = useState(false);
  const [mimeType, setMimeType] = useState("");
  // sequence tracking internal only
  const [, /*seq*/ setSeq] = useState(0);
  const [lastChunkTs, setLastChunkTs] = useState(null);
  const [peerCount, setPeerCount] = useState(0);
  const [autoForward, setAutoForward] = useState(true);
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: "",
    severity: "info",
  });
  const [initializing, setInitializing] = useState(false);
  const [lagMs, setLagMs] = useState(0);
  const [selfPeerId, setSelfPeerId] = useState("");
  const [participants, setParticipants] = useState([]); // peerIds that have produced or consumed chunks
  const [manualPeerId, setManualPeerId] = useState("");
  const [manualConnectMsg, setManualConnectMsg] = useState("");
  const [connectionsSnapshot, setConnectionsSnapshot] = useState([]);

  // Add closeMsg function
  const closeMsg = () => {
    setSnackbar({ ...snackbar, open: false });
  };
  const [connectionType, setConnectionType] = useState("webrtc"); // 'webrtc' | 'libp2p-protocol'

  // Stream health monitoring
  const lastFrameTimeRef = useRef(Date.now());
  const chunkQueueRef = useRef([]);
  const isProcessingQueueRef = useRef(false);
  const streamHealthIntervalRef = useRef(null);
  const recoveryStateRef = useRef({
    isRequestingInit: false,
    isRestartingICE: false,
    isReconnecting: false,
  });

  const [streamHealth, setStreamHealth] = useState({
    framesReceived: 0,
    lastFrameTime: 0,
    isStalled: false,
    bufferHealth: "unknown",
  });

  const mediaRecorderRef = useRef(null);
  const initSegmentRef = useRef(null); // first segment (init) to replay to late-joiners
  const localStreamRef = useRef(null);
  const fileInputRef = useRef(null);
  const fileUrlRef = useRef(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [sourceMode, setSourceMode] = useState("camera"); // 'camera' | 'file' | 'file-audio'
  const videoLocalRef = useRef(null);
  const videoRemoteRef = useRef(null);
  const mediaSourceRef = useRef(null);
  const sourceBufferRef = useRef(null);
  const pendingBuffersRef = useRef([]); // queued while SourceBuffer busy
  const earlyBuffersRef = useRef([]); // chunks before SourceBuffer exists
  const currentMimeTypeRef = useRef(null);
  const firstRemoteFrameRef = useRef(false);
  const [remoteMuted, setRemoteMuted] = useState(true);
  const [debugLog, setDebugLog] = useState(false);
  const debugLogRef = useRef(false); // Add this ref for debug logging
  const framesReceivedRef = useRef(0); // track frames for retry loop
  const initRetryIntervalRef = useRef(null);

  // Add missing refs
  const lastSeqRef = useRef(-1);
  const consumersRef = useRef([]);
  const reinitIntervalRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);
  const mediaSourceResetTimeoutRef = useRef(null);
  const peerConnectionsRef = useRef(new Map());
  const dataChannelsRef = useRef(new Map());
  const videoProtocolPeersRef = useRef(new Set()); // track peers we have active video protocol streams with
  const webrtcStreamRef = useRef(null);
  const peerConnectionRef = useRef(null); // For single peer connection
  const videoRef = useRef(null); // Add video ref for health monitoring
  const statIntervalRef = useRef(null); // Add stat interval ref
  const connIntervalRef = useRef(null); // Add connection interval ref

  // WebRTC states
  const [useWebRTC, setUseWebRTC] = useState(true);
  const [webrtcConnections, setWebrtcConnections] = useState([]);
  const [publisherPeerId, setPublisherPeerId] = useState(""); // Add publisherPeerId state

  const stopBroadcast = async () => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop();
    }
    // stop tracks only for camera streams; if using file captureStream, avoid stopping the file playback
    if (localStreamRef.current) {
      try {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      } catch (e) {
        /* ignore */
      }
      localStreamRef.current = null;
    }
    // cleanup selected file object URL
    if (fileUrlRef.current) {
      try {
        URL.revokeObjectURL(fileUrlRef.current);
      } catch (e) {}
      fileUrlRef.current = null;
      setSelectedFile(null);
      if (videoLocalRef.current) videoLocalRef.current.src = "";
    }
    // cleanup WebRTC connections
    for (const [peerId, pc] of peerConnectionsRef.current) {
      try {
        pc.close();
        if (debugLogRef.current)
          console.log("[WEBRTC] Closed connection to", peerId);
      } catch (e) {
        console.warn("[WEBRTC] Error closing connection to", peerId, e);
      }
    }
    peerConnectionsRef.current.clear();
    dataChannelsRef.current.clear();
    webrtcStreamRef.current = null;
    setWebrtcConnections([]);

    reinitIntervalRef.current && clearInterval(reinitIntervalRef.current);
    heartbeatIntervalRef.current && clearInterval(heartbeatIntervalRef.current);
    setBroadcasting(false);
    showMsg("Broadcast stopped", "info");
  };

  const resetRecoveryState = () => {
    recoveryStateRef.current = {
      isRequestingInit: false,
      isRestartingICE: false,
      isReconnecting: false,
    };
  };

  // Reset MediaSource pipeline when SourceBuffer becomes invalid
  const resetMediaSourcePipeline = useCallback(() => {
    try {
      console.log("[STREAM][RESET] Resetting MediaSource pipeline");

      // Clear timeouts
      if (mediaSourceResetTimeoutRef.current) {
        clearTimeout(mediaSourceResetTimeoutRef.current);
        mediaSourceResetTimeoutRef.current = null;
      }

      // Store current pending buffers to early buffers
      if (pendingBuffersRef.current.length > 0) {
        earlyBuffersRef.current.push(...pendingBuffersRef.current);
        pendingBuffersRef.current = [];
      }

      // Clean up current MediaSource
      if (sourceBufferRef.current) {
        sourceBufferRef.current = null;
      }

      if (mediaSourceRef.current) {
        try {
          if (mediaSourceRef.current.readyState === "open") {
            console.log(
              "[STREAM][RESET] (skip endOfStream to avoid premature close)"
            );
            // intentionally NOT calling endOfStream here to prevent auto-closing during active playback
          }
        } catch (e) {
          /* ignore */
        }
        mediaSourceRef.current = null;
      }

      if (videoRemoteRef.current) {
        try {
          URL.revokeObjectURL(videoRemoteRef.current.src);
          videoRemoteRef.current.src = "";
        } catch (e) {
          /* ignore */
        }
      }

      // Reset flags
      firstRemoteFrameRef.current = false;

      // Re-setup MediaSource if we have a mimeType
      if (mimeType) {
        setTimeout(() => {
          console.log("[STREAM][RESET] Re-setting up MediaSource after reset");
          if (!("MediaSource" in window)) {
            console.error("[STREAM][RESET] MediaSource API not supported");
            return;
          }

          const ms = new MediaSource();
          mediaSourceRef.current = ms;
          videoRemoteRef.current.src = URL.createObjectURL(ms);

          ms.addEventListener("sourceopen", () => {
            try {
              if (ms !== mediaSourceRef.current || ms.readyState !== "open") {
                console.warn(
                  "[STREAM][RESET] MediaSource state changed during reset sourceopen"
                );
                return;
              }

              const sb = ms.addSourceBuffer(mimeType);
              console.log(
                "[STREAM][RESET] SourceBuffer recreated with mimeType=",
                mimeType
              );

              sourceBufferRef.current = sb;
              sb.mode = "sequence";

              // Re-attach event listeners
              sb.addEventListener("updateend", () => {
                const currentSb = sourceBufferRef.current;
                const currentMs = mediaSourceRef.current;

                if (
                  !currentSb ||
                  !currentMs ||
                  currentMs.readyState !== "open" ||
                  !Array.from(currentMs.sourceBuffers).includes(currentSb)
                ) {
                  return;
                }

                if (
                  pendingBuffersRef.current.length > 0 &&
                  !currentSb.updating
                ) {
                  const next = pendingBuffersRef.current.shift();
                  if (next) {
                    try {
                      currentSb.appendBuffer(next);
                    } catch (e) {
                      console.error(
                        "[STREAM][RESET UPDATEEND] Failed to append buffer",
                        e
                      );
                    }
                  }
                }

                if (
                  !firstRemoteFrameRef.current &&
                  videoRemoteRef.current &&
                  videoRemoteRef.current.readyState >= 2
                ) {
                  firstRemoteFrameRef.current = true;
                  videoRemoteRef.current.play().catch(() => {});
                }
              });

              // Process early buffers
              if (earlyBuffersRef.current.length) {
                console.log(
                  "[STREAM][RESET] Processing early buffers count=",
                  earlyBuffersRef.current.length
                );
                while (earlyBuffersRef.current.length) {
                  const buf = earlyBuffersRef.current.shift();
                  try {
                    if (!sb.updating && ms.readyState === "open") {
                      sb.appendBuffer(buf);
                    } else {
                      pendingBuffersRef.current.push(buf);
                    }
                  } catch (e) {
                    console.error(
                      "[STREAM][RESET] Failed to append early buffer",
                      e
                    );
                    pendingBuffersRef.current.push(buf);
                  }
                }
              }
            } catch (err) {
              console.error(
                "[STREAM][RESET] Error setting up reset SourceBuffer",
                err
              );
            }
          });
        }, 100);
      }
    } catch (e) {
      console.error("[STREAM][RESET] Error during MediaSource reset", e);
    }
  }, [mimeType]);

  const appendChunk = useCallback(
    (newChunk) => {
      // If a new chunk is provided, add it to the queue
      if (newChunk) {
        chunkQueueRef.current.push(newChunk);
        console.log(
          "[STREAM][QUEUE] Added chunk to queue, queue length:",
          chunkQueueRef.current.length
        );
      }

      // Process the queue
      if (isProcessingQueueRef.current || chunkQueueRef.current.length === 0) {
        return;
      }
      isProcessingQueueRef.current = true;

      const chunk = chunkQueueRef.current.shift();
      console.log(
        "[STREAM][APPEND] Processing chunk from queue, remaining:",
        chunkQueueRef.current.length
      );
      // If SourceBuffer not ready yet, stash as early buffer and retry shortly
      const sbReady = () => {
        const ms = mediaSourceRef.current;
        const sb = sourceBufferRef.current;
        return (
          ms &&
          sb &&
          ms.readyState === "open" &&
          Array.from(ms.sourceBuffers).includes(sb) &&
          !sb.updating
        );
      };
      if (!sbReady()) {
        // Stash ALL early chunks until SourceBuffer exists; preserves ordering
        try {
          earlyBuffersRef.current.push(chunk);
        } catch {}
        lastFrameTimeRef.current = Date.now(); // treat as received to avoid false stall
        console.log(
          "[STREAM][APPEND DEFERRING] Stashed early chunk; earlyBuffers length=",
          earlyBuffersRef.current.length
        );
        isProcessingQueueRef.current = false;
        setTimeout(() => appendChunk(), 120);
        return;
      }
      try {
        sourceBufferRef.current.appendBuffer(chunk);
        console.log(
          "[STREAM][APPEND] Successfully appended chunk, size:",
          chunk.byteLength,
          "bytes"
        );

        // Update health stats immediately after successful append call
        lastFrameTimeRef.current = Date.now();
        resetRecoveryState(); // A successful append resets all recovery stages
        framesReceivedRef.current += 1;
        setStreamHealth((prev) => {
          const newFramesReceived = prev.framesReceived + 1;
          const buffer = sourceBufferRef.current;
          const bufferLength =
            buffer.buffered.length > 0
              ? buffer.buffered.end(0) - buffer.buffered.start(0)
              : 0;
          const bufferHealth =
            bufferLength > 2
              ? "healthy"
              : bufferLength > 0.5
              ? "low"
              : "critical";
          console.log(
            "[STREAM][HEALTH] Buffer health:",
            bufferHealth,
            "buffer length:",
            bufferLength,
            "frames:",
            newFramesReceived
          );
          return {
            ...prev,
            framesReceived: newFramesReceived,
            lastFrameTime: Date.now(),
            isStalled: false,
            bufferHealth,
          };
        });

        // Try to play video if it's not already playing
        if (
          videoRemoteRef.current &&
          videoRemoteRef.current.paused &&
          videoRemoteRef.current.readyState >= 2
        ) {
          console.log(
            "[STREAM][PLAY] Attempting to play video - readyState:",
            videoRemoteRef.current.readyState
          );
          videoRemoteRef.current
            .play()
            .then(() => {
              console.log("[STREAM][PLAY] Video play() resolved successfully");
            })
            .catch((e) => {
              console.error("[STREAM][PLAY] Video play() failed:", e);
            });
        }
      } catch (e) {
        console.error("[STREAM][APPEND ERR] appendBuffer failed", e);

        // If SourceBuffer was removed, reset the media pipeline
        if (
          e.name === "InvalidStateError" &&
          e.message.includes("removed from the parent media source")
        ) {
          console.warn(
            "[STREAM][APPEND ERR] SourceBuffer removed, resetting MediaSource pipeline"
          );
          resetMediaSourcePipeline();
          return;
        }

        // If append fails for other reasons, push chunk back to pending and try a single retry after a short delay
        pendingBuffersRef.current.unshift(chunk);
        setTimeout(() => {
          try {
            const sb2 = sourceBufferRef.current;
            const ms2 = mediaSourceRef.current;
            if (
              sb2 &&
              ms2 &&
              ms2.readyState === "open" &&
              Array.from(ms2.sourceBuffers).includes(sb2) &&
              !sb2.updating &&
              pendingBuffersRef.current.length > 0
            ) {
              const nxt = pendingBuffersRef.current.shift();
              if (nxt) sb2.appendBuffer(nxt);
            }
          } catch (e2) {
            console.error("[STREAM][APPEND RETRY ERR]", e2);
          }
        }, 400);
      } finally {
        isProcessingQueueRef.current = false;
        // Process the next chunk in the queue if available
        if (chunkQueueRef.current.length > 0) {
          setTimeout(() => appendChunk(), 0); // Use setTimeout to avoid deep recursion
        }
      }
    },
    [resetMediaSourcePipeline]
  );

  // Extract updateend handler for proper cleanup
  const handleUpdateEnd = useCallback(() => {
    const sb = sourceBufferRef.current;
    const ms = mediaSourceRef.current;

    // Validate state before processing pending buffers
    if (
      !sb ||
      !ms ||
      ms.readyState !== "open" ||
      !Array.from(ms.sourceBuffers).includes(sb)
    ) {
      if (debugLogRef.current)
        console.warn(
          "[STREAM][UPDATEEND] Invalid state, skipping pending buffer processing"
        );
      return;
    }

    if (pendingBuffersRef.current.length > 0 && !sb.updating) {
      const next = pendingBuffersRef.current.shift();
      if (next) {
        try {
          sb.appendBuffer(next);
        } catch (e) {
          console.error("[STREAM][UPDATEEND] Failed to append next buffer", e);
          if (
            e.name === "InvalidStateError" &&
            e.message.includes("removed from the parent media source")
          ) {
            resetMediaSourcePipeline();
          }
        }
      }
    }

    try {
      console.log(
        "[STREAM][MSE] updateend; buffered=",
        sb.buffered.length ? sb.buffered.end(0) - sb.buffered.start(0) : 0,
        "pending=",
        pendingBuffersRef.current.length
      );
    } catch (e) {}

    if (
      !firstRemoteFrameRef.current &&
      videoRemoteRef.current &&
      videoRemoteRef.current.readyState >= 2
    ) {
      firstRemoteFrameRef.current = true;
      videoRemoteRef.current.play().catch(() => {});
    }
  }, [resetMediaSourcePipeline]);

  // helper to request a fresh init segment (keyframe) from broadcaster
  const requestInit = useCallback(
    (reason = "manual") => {
      try {
        const lp = libp2pState;
        if (!lp) return;
        const msg = {
          type: "request-init",
          ts: Date.now(),
          from: lp.peerId.toString(),
          reason,
        };
        lp.services.pubsub
          .publish(topicName, new TextEncoder().encode(JSON.stringify(msg)))
          .catch(() => {});
        if (debugLogRef.current) console.log("[STREAM][REQUEST INIT]", reason);
      } catch (e) {
        console.warn("[STREAM][REQUEST INIT ERROR]", e);
      }
    },
    [libp2pState, topicName]
  );

  // WebRTC functions
  const createPeerConnection = async (peerId) => {
    try {
      const pc = new RTCPeerConnection(RTC_CONFIG);

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignalingMessage(peerId, {
            type: "ice-candidate",
            candidate: event.candidate,
          });
        }
      };

      // Handle connection state changes
      pc.onconnectionstatechange = () => {
        console.log(
          `[WEBRTC] Connection state for ${peerId}: ${pc.connectionState}`
        );
      };

      peerConnectionsRef.current.set(peerId, pc);
      return pc;
    } catch (e) {
      console.error("[WEBRTC] Failed to create peer connection", e);
      return null;
    }
  };

  const sendSignalingMessage = (peerId, message) => {
    try {
      const lp = libp2pState;
      if (!lp) return;

      const signalingMsg = {
        type: "webrtc-signaling",
        from: lp.peerId.toString(),
        to: peerId,
        message: message,
        ts: Date.now(),
      };

      lp.services.pubsub
        .publish(
          topicName,
          new TextEncoder().encode(JSON.stringify(signalingMsg))
        )
        .catch(() => {});
    } catch (e) {
      console.warn("[WEBRTC] Failed to send signaling message", e);
    }
  };

  const handleSignalingMessage = async (msg) => {
    console.log("handleSignalingMessage ----❤️💖 --", msg);
    try {
      const parsed = JSON.parse(new TextDecoder().decode(msg.data));
      if (
        parsed.type !== "webrtc-signaling" ||
        parsed.to !== libp2pState?.peerId?.toString()
      ) {
        return;
      }
      console.log(parsed);
      const peerId = parsed.from;
      let pc = peerConnectionsRef.current.get(peerId);

      if (!pc) {
        pc = await createPeerConnection(peerId);
        if (!pc) return;
      }

      const signalingMsg = parsed.message;

      if (signalingMsg.type === "offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(signalingMsg));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignalingMessage(peerId, {
          type: "answer",
          sdp: answer.sdp,
        });
      } else if (signalingMsg.type === "answer") {
        await pc.setRemoteDescription(new RTCSessionDescription(signalingMsg));
      } else if (signalingMsg.type === "ice-candidate") {
        await pc.addIceCandidate(new RTCIceCandidate(signalingMsg.candidate));
      }
    } catch (e) {
      console.error("[WEBRTC] Failed to handle signaling message", e);
    }
  };

  // Add initiateWebRTCConnection function
  const initiateWebRTCConnection = async (targetPeerId) => {
    try {
      console.log("[WEBRTC] Initiating connection to", targetPeerId);
      const pc = await createPeerConnection(targetPeerId);
      if (!pc) return;

      // Add local stream if broadcasting
      if (webrtcStreamRef.current) {
        webrtcStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, webrtcStreamRef.current);
        });
      }

      // Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sendSignalingMessage(targetPeerId, {
        type: "offer",
        sdp: offer.sdp,
      });

      console.log("[WEBRTC] Offer sent to", targetPeerId);
    } catch (e) {
      console.error("[WEBRTC] Failed to initiate connection", e);
    }
  };

  // Setup remote playback pipeline (MediaSource)
  const setupMediaSource = useCallback(
    (mt) => {
      if (
        currentMimeTypeRef.current === mt &&
        mediaSourceRef.current &&
        sourceBufferRef.current
      ) {
        // Already set up for this mime, skip
        return;
      }
      console.log("[STREAM][MSE] setupMediaSource start mimeType=", mt);
      if (!("MediaSource" in window)) {
        showMsg("MediaSource API not supported in this browser", "error");
        return;
      }

      // Clean up existing MediaSource if mime changes
      if (mediaSourceRef.current && currentMimeTypeRef.current !== mt) {
        try {
          if (mediaSourceRef.current.readyState === "open") {
            console.log(
              "[STREAM][MSE] closing previous MediaSource for mime change"
            );
            // Avoid endOfStream; just let old object be GC'd after detaching
          }
        } catch (e) {
          /* ignore */
        }
      }

      if (videoRemoteRef.current && videoRemoteRef.current.src) {
        try {
          URL.revokeObjectURL(videoRemoteRef.current.src);
        } catch (e) {
          /* ignore */
        }
      }

      const ms = new MediaSource();
      mediaSourceRef.current = ms;
      currentMimeTypeRef.current = mt;
      videoRemoteRef.current.src = URL.createObjectURL(ms);

      console.log(
        "[STREAM][MSE] MediaSource created, URL assigned to video element"
      );

      // Add video element event listeners for debugging
      const video = videoRemoteRef.current;
      video.addEventListener("loadstart", () =>
        console.log("[VIDEO] loadstart")
      );
      video.addEventListener("loadedmetadata", () =>
        console.log(
          "[VIDEO] loadedmetadata - duration:",
          video.duration,
          "readyState:",
          video.readyState
        )
      );
      video.addEventListener("loadeddata", () =>
        console.log("[VIDEO] loadeddata - readyState:", video.readyState)
      );
      video.addEventListener("canplay", () =>
        console.log("[VIDEO] canplay - can start playing")
      );
      video.addEventListener("canplaythrough", () =>
        console.log("[VIDEO] canplaythrough - can play without interruption")
      );
      video.addEventListener("play", () =>
        console.log("[VIDEO] play event fired")
      );
      video.addEventListener("playing", () =>
        console.log("[VIDEO] playing - video is actually playing")
      );
      video.addEventListener("pause", () => console.log("[VIDEO] pause"));
      video.addEventListener("waiting", () =>
        console.log("[VIDEO] waiting - waiting for data")
      );
      video.addEventListener("stalled", () =>
        console.log("[VIDEO] stalled - network stalled")
      );
      video.addEventListener("error", (e) =>
        console.error("[VIDEO] error:", e, video.error)
      );

      ms.addEventListener("sourceopen", () => {
        try {
          // Double-check MediaSource is still valid
          if (ms !== mediaSourceRef.current || ms.readyState !== "open") {
            console.warn(
              "[STREAM][MSE] MediaSource state changed during sourceopen, aborting setup"
            );
            return;
          }

          const sb = ms.addSourceBuffer(mt);
          console.log(
            "[STREAM][MSE] SourceBuffer created with mimeType=",
            mt,
            "mediaSource.readyState=",
            ms.readyState
          );

          // detailed SB event logging
          sb.addEventListener("error", (ev) =>
            console.error("[STREAM][MSE] SourceBuffer ERROR", ev)
          );
          sb.addEventListener("abort", (ev) =>
            console.warn("[STREAM][MSE] SourceBuffer ABORT", ev)
          );
          sb.addEventListener("update", () => {
            if (debugLogRef.current)
              console.log("[STREAM][MSE] SourceBuffer update");
          });

          sourceBufferRef.current = sb;
          sb.mode = "sequence";
          sb.addEventListener("updateend", handleUpdateEnd);

          // flush early buffers
          if (earlyBuffersRef.current.length) {
            console.log(
              "[STREAM][MSE] appending early buffers count=",
              earlyBuffersRef.current.length
            );
            while (earlyBuffersRef.current.length) {
              const buf = earlyBuffersRef.current.shift();
              try {
                if (
                  !sb.updating &&
                  ms.readyState === "open" &&
                  Array.from(ms.sourceBuffers).includes(sb)
                ) {
                  sb.appendBuffer(buf);
                  if (debugLogRef.current)
                    console.log(
                      "[STREAM][MSE] appended early buffer size=",
                      (buf && buf.byteLength) || (buf && buf.length)
                    );
                } else {
                  pendingBuffersRef.current.push(buf);
                }
              } catch (e) {
                console.error("[STREAM][MSE] append early buffer failed", e);
                pendingBuffersRef.current.push(buf);
              }
            }
          }
          console.log(
            "[STREAM][MSE] flushed early buffers, pending:",
            pendingBuffersRef.current.length
          );
        } catch (err) {
          console.error("SourceBuffer error", err);
          showMsg("Failed to init SourceBuffer", "error");
        }
      });

      // Watchdog: if no SourceBuffer after 1s, retry with fallback mime types
      setTimeout(() => {
        if (!sourceBufferRef.current && mediaSourceRef.current === ms) {
          console.warn(
            "[STREAM][MSE][WATCHDOG] SourceBuffer not created yet; retrying with fallback"
          );
          let fallbacks = [
            "video/webm;codecs=vp8,opus",
            "video/webm;codecs=vp8",
            "video/webm",
          ];
          const next = fallbacks.find(
            (f) => f !== mt && MediaSource.isTypeSupported(f)
          );
          if (next) {
            setupMediaSource(next);
            // request a fresh init since we changed mimeType
            requestInit("watchdog-fallback");
          }
        }
      }, 1000);

      ms.addEventListener("sourceclose", () => {
        console.log("[STREAM][MSE] MediaSource closed");
        if (sourceBufferRef.current) {
          sourceBufferRef.current = null;
        }
      });

      ms.addEventListener("sourceended", () => {
        console.log("[STREAM][MSE] MediaSource ended");
      });
    },
    [handleUpdateEnd, requestInit]
  );

  const startBroadcast = async () => {
    const lp = await ensureLibp2p();
    if (!lp) return;
    try {
      if (debugLogRef.current)
        console.log("[STREAM][DEBUG] startBroadcast invoked");
      // Ensure bootstrap connection BEFORE starting capture / publishing (hard requirement)
      const bootstrapAddr = BOOTSTRAP_MULTIADDRS[0];
      if (bootstrapAddr) {
        const bootstrapPeerId = bootstrapAddr.split("/p2p/")[1];
        let connectedIds = lp
          .getConnections()
          .map((c) => c.remotePeer.toString());
        console.log("⚡🌙 🌄❤️ start broadcasting");
        console.log(bootstrapPeerId);
        console.log(connectedIds);
        if (bootstrapPeerId && !connectedIds.includes(bootstrapPeerId)) {
          try {
            showMsg("Connecting to bootstrap node...", "info");
            const connected = await lp.dial(multiaddr(bootstrapAddr));
            console.log(bootstrapAddr);
            console.log(connected);
            connectedIds = lp
              .getConnections()
              .map((c) => c.remotePeer.toString());
            console.log(connectedIds);
            console.log("⚡🌙 🌄❤️ reconnect to bootstrap");
          } catch (e) {
            console.warn("Bootstrap dial attempt failed", e);
          }
        }
        if (!connectedIds.includes(bootstrapPeerId)) {
          showMsg("Cannot broadcast: not connected to bootstrap node", "error");
          return;
        }
      }
      console.log("selfPeerId", selfPeerId);
      if (!selfPeerId) {
        try {
          setSelfPeerId(lp.peerId.toString());
        } catch {}
      }
      console.log("selfPeerId", selfPeerId);
      // Build mediaStream according to sourceMode
      let mediaStream = null;
      console.log("sourceMode", sourceMode);
      if (sourceMode === "camera") {
        const constraints = { audio: true, video: { width: 640, height: 360 } };
        mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (videoLocalRef.current)
          videoLocalRef.current.srcObject = mediaStream;
        console.log(mediaStream);
        console.log("videoLocalRef", videoLocalRef);
      } else if (sourceMode === "file") {
        if (!(selectedFile && fileUrlRef.current && videoLocalRef.current)) {
          showMsg("Select a file first", "error");
          return;
        }
        try {
          const v = videoLocalRef.current;
          mediaStream = v.captureStream ? v.captureStream() : null;
          if (!mediaStream)
            throw new Error("captureStream not supported for this file");
        } catch (e) {
          console.warn("file captureStream failed", e);
          showMsg("File capture not supported", "error");
          return;
        }
      } else if (sourceMode === "file-audio") {
        if (!(selectedFile && fileUrlRef.current && videoLocalRef.current)) {
          showMsg("Select a file first", "error");
          return;
        }
        try {
          const v = videoLocalRef.current;
          const videoStream = v.captureStream ? v.captureStream() : null;
          if (!videoStream)
            throw new Error("captureStream not supported for this file");
          // get camera audio only
          const audioStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
          // combine video track from file with camera audio track
          const combined = new MediaStream();
          videoStream.getVideoTracks().forEach((t) => combined.addTrack(t));
          audioStream.getAudioTracks().forEach((t) => combined.addTrack(t));
          mediaStream = combined;
        } catch (e) {
          console.warn("file+audio capture failed", e);
          showMsg("File+camera audio not supported", "error");
          return;
        }
      }
      localStreamRef.current = mediaStream;
      webrtcStreamRef.current = mediaStream; // Store for WebRTC

      // Pick a supported mime type (prefer VP8+Opus for broader compatibility)
      const preferred = [
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8",
        "video/webm",
      ];
      let selected =
        preferred.find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const recorderOpts = selected
        ? { mimeType: selected, videoBitsPerSecond: 600_000 }
        : {};
      console.log("selected", selected);
      const mr = new MediaRecorder(mediaStream, recorderOpts);
      setMimeType(selected || mr.mimeType);
      mediaRecorderRef.current = mr;
      lastSeqRef.current = -1;
      setSeq(0);
      // Ensure we are subscribed too (improves mesh formation for gossipsub and guarantees receipt of request-init)
      try {
        if (!lp.services.pubsub.getTopics().includes(topicName)) {
          console.log(
            "[STREAM][BROADCAST] self-subscribing to topic before publish"
          );
          // Some pubsub impls allow handler arg; we just call bare subscribe here
          await lp.services.pubsub.subscribe(topicName);
        }
      } catch (e) {
        console.warn(
          "[STREAM][BROADCAST] self subscribe failed (non fatal)",
          e
        );
      }
      // Send init header (and remember mimeType)
      const initPayload = {
        type: "init",
        mimeType: selected || mr.mimeType,
        ts: Date.now(),
        from: lp.peerId.toString(),
      };
      // publish init via pubsub for discovery; actual chunks will be sent over direct protocol
      await lp.services.pubsub.publish(
        topicName,
        new TextEncoder().encode(JSON.stringify(initPayload))
      );
      console.log("[STREAM][SEND INIT]", initPayload);
      if (debugLogRef.current)
        console.log(
          "[STREAM][SEND INIT CONFIRM] topics now",
          lp.services.pubsub.getTopics?.()
        );
      setParticipants((prev) =>
        prev.includes(lp.peerId.toString())
          ? prev
          : [...prev, lp.peerId.toString()]
      );

      // Listen for request-init messages to re-broadcast init to late joiners
      const onMessage = (evt) => {
        console.log("on message =======", evt);
        const msgObj = evt.detail;
        if (!msgObj || msgObj.topic !== topicName) return;
        try {
          const txt = new TextDecoder().decode(msgObj.data);
          const parsed = JSON.parse(txt);
          if (parsed.type === "request-init") {
            // If we have an init segment available, include it as base64 so late joiners can start playback
            if (initSegmentRef.current) {
              const b64 = bufToBase64(initSegmentRef.current);
              const payload = {
                ...initPayload,
                ts: Date.now(),
                replay: true,
                b64,
              };
              lp.services.pubsub
                .publish(
                  topicName,
                  new TextEncoder().encode(JSON.stringify(payload))
                )
                .catch(() => {});
            } else {
              // Fallback: replay metadata only
              lp.services.pubsub
                .publish(
                  topicName,
                  new TextEncoder().encode(
                    JSON.stringify({
                      ...initPayload,
                      ts: Date.now(),
                      replay: true,
                    })
                  )
                )
                .catch(() => {});
            }
          }
        } catch {}
      };
      lp.services.pubsub.removeEventListener("message", onMessage); // ensure single
      lp.services.pubsub.addEventListener("message", onMessage);
      // When we produce chunks, push them to connected consumers over the protocol

      mr.ondataavailable = async (e) => {
        console.log("rm.ondataaviable ======.>.>>>>>", e);
        if (!e.data || e.data.size === 0) return;
        const arrayBuf = await e.data.arrayBuffer();
        const nextSeq = lastSeqRef.current + 1;
        lastSeqRef.current = nextSeq;
        setSeq(nextSeq);
        // frame buffer to send
        const frame = new Uint8Array(arrayBuf);
        // store the first recorded segment as init segment so late-joiners can be replayed
        if (nextSeq === 0 && !initSegmentRef.current) {
          try {
            initSegmentRef.current = frame.slice();
          } catch (e) {
            initSegmentRef.current = new Uint8Array(frame);
          }
          // Proactively publish init WITH b64 to help early viewers who already requested init before first segment was ready
          try {
            const b64 = bufToBase64(initSegmentRef.current);
            const enriched = {
              type: "init",
              mimeType: selected || mr.mimeType,
              ts: Date.now(),
              from: lp.peerId.toString(),
              replay: true,
              b64,
              firstSegment: true,
            };
            await lp.services.pubsub.publish(
              topicName,
              new TextEncoder().encode(JSON.stringify(enriched))
            );
            if (debugLogRef.current)
              console.log(
                "[STREAM][SEND INIT WITH B64] first segment bytes=",
                initSegmentRef.current.length
              );
          } catch (ePublish) {
            console.warn("[STREAM][SEND INIT WITH B64 ERROR]", ePublish);
          }
        }
        if (debugLogRef.current)
          console.log(
            "[STREAM][SEND CHUNK PROTO] seq",
            nextSeq,
            "bytes",
            frame.length
          );
        // send to each consumer via their stream
        let protocolSent = false;
        for (const consumer of consumersRef.current || []) {
          try {
            const lenBuf = new Uint8Array(4);
            new DataView(lenBuf.buffer).setUint32(0, frame.length, false);
            // push length and frame into consumer queue
            consumer.push(lenBuf);
            consumer.push(frame);
            protocolSent = true;
          } catch (err) {
            console.warn("[STREAM][PROTO SEND FAIL] consumer", err);
          }
        }
        // Fallback: if no protocol consumers, also send via pubsub for immediate delivery
        if (!protocolSent) {
          // send via pubsub until at least one protocol consumer is connected
          try {
            const b64 = bufToBase64(frame);
            const chunkMsg = {
              type: "chunk",
              seq: nextSeq,
              b64,
              ts: Date.now(),
              from: lp.peerId.toString(),
            };
            lp.services.pubsub
              .publish(
                topicName,
                new TextEncoder().encode(JSON.stringify(chunkMsg))
              )
              .catch(() => {});
            if (debugLogRef.current)
              console.log("[STREAM][SEND CHUNK PUBSUB FALLBACK] seq", nextSeq);
          } catch (eFallback) {
            console.warn("[STREAM][PUBSUB FALLBACK ERROR]", eFallback);
          }
        }
        setLastChunkTs(new Date());
      };
      const segmentMs = 800; // shorter segments reduce startup latency and fragmentation
      console.log("mr.start.", segmentMs);
      mr.start(segmentMs);
      // Heartbeat + periodic init re-broadcast (late join resilience & diagnostics)
      reinitIntervalRef.current && clearInterval(reinitIntervalRef.current);
      reinitIntervalRef.current = setInterval(() => {
        let rein = { ...initPayload, ts: Date.now(), periodic: true };
        if (initSegmentRef.current) {
          const b64 = bufToBase64(initSegmentRef.current);
          rein = { ...rein, b64 };
        }
        lp.services.pubsub
          .publish(topicName, new TextEncoder().encode(JSON.stringify(rein)))
          .then(() => {
            if (debugLogRef.current)
              console.log("[STREAM][RE-SEND INIT]", rein);
          })
          .catch((e) => console.warn("[STREAM][RE-SEND INIT ERROR]", e));
      }, 15000);
      heartbeatIntervalRef.current &&
        clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = setInterval(() => {
        const hb = { type: "hb", ts: Date.now(), from: lp.peerId.toString() };
        lp.services.pubsub
          .publish(topicName, new TextEncoder().encode(JSON.stringify(hb)))
          .catch(() => {});
      }, 5000);
      setBroadcasting(true);
      showMsg("Broadcast started", "success");

      // register protocol handler to accept inbound connections from viewers
      try {
        lp.handle(VIDEO_PROTOCOL, async ({ stream, connection }) => {
          if (debugLogRef.current)
            console.log(
              "[STREAM][PROTO] viewer connected",
              connection.remotePeer.toString()
            );
          // create a pushable queue for this consumer
          class AsyncQueue {
            constructor() {
              this.items = [];
              this.resolvers = [];
              this.ended = false;
            }
            push(item) {
              if (this.ended) return;
              if (this.resolvers.length) {
                const r = this.resolvers.shift();
                r({ value: item, done: false });
              } else this.items.push(item);
            }
            close() {
              this.ended = true;
              while (this.resolvers.length) {
                const r = this.resolvers.shift();
                r({ done: true });
              }
            }
            [Symbol.asyncIterator]() {
              const self = this;
              return {
                next() {
                  if (self.items.length)
                    return Promise.resolve({
                      value: self.items.shift(),
                      done: false,
                    });
                  if (self.ended) return Promise.resolve({ done: true });
                  return new Promise((res) => self.resolvers.push(res));
                },
              };
            }
          }
          const q = new AsyncQueue();
          const writerPromise = stream.sink(q[Symbol.asyncIterator]());
          const consumerObj = {
            id: connection.remotePeer.toString(),
            push: (c) => q.push(c),
            end: () => q.close(),
          };
          consumersRef.current.push(consumerObj);
          // Immediately send stored init segment if available so viewer can initialize MediaSource
          if (initSegmentRef.current) {
            try {
              const initBuf = initSegmentRef.current;
              const lenBuf = new Uint8Array(4);
              new DataView(lenBuf.buffer).setUint32(0, initBuf.length, false);
              consumerObj.push(lenBuf);
              consumerObj.push(initBuf);
              if (debugLogRef.current)
                console.log(
                  "[STREAM][PROTO] sent init segment to",
                  consumerObj.id,
                  "bytes=",
                  initBuf.length
                );
            } catch (e) {
              console.warn("[STREAM][PROTO] init send failed", e);
            }
          }
          // also drain any inbound data (viewer->broadcaster) but ignore content
          (async () => {
            try {
              for await (const _ of stream.source) {
                void _;
              }
            } catch (e) {
              /* ignore */
            }
          })();
          // wait for writer finish then cleanup
          writerPromise
            .then(() => {
              consumersRef.current = consumersRef.current.filter(
                (c) => c.id !== consumerObj.id
              );
              consumerObj.end();
              if (debugLogRef.current)
                console.log(
                  "[STREAM][PROTO] writer finished for",
                  consumerObj.id
                );
            })
            .catch(() => {
              consumersRef.current = consumersRef.current.filter(
                (c) => c.id !== consumerObj.id
              );
              consumerObj.end();
            });
        });
      } catch (e) {
        console.warn("[STREAM] protocol handler register failed", e);
      }
    } catch (err) {
      console.error(err);
      showMsg("Cannot start broadcast", "error");
    }
  };

  const showMsg = (message, severity = "info") => {
    setSnackbar({ open: true, message, severity });
  };

  // Subscription logic
  const subscribe = useCallback(async () => {
    let lp;
    console.log("[STREAM][DEBUG] Subscribe button clicked");
    console.log(
      "[STREAM][DEBUG] libp2pState:",
      lp ? "exists" : "null/undefined"
    );
    console.log("[STREAM][DEBUG] subscribed:", subscribed);
    console.log("[STREAM][DEBUG] topicName:", topicName);

    // Try to initialize libp2p if not connected
    if (!lp) {
      console.log(
        "[STREAM][DEBUG] No libp2p instance, attempting to initialize..."
      );
      lp = await ensureLibp2p();
      if (!lp) {
        console.error("[STREAM][DEBUG] Failed to initialize libp2p");
        showMsg(
          "Failed to connect to libp2p network. Please try connecting manually first.",
          "error"
        );
        return;
      }
    }

    if (subscribed) {
      console.log("[STREAM][DEBUG] Already subscribed, ignoring");
      return;
    }

    console.log(`[STREAM] Subscribing to topic: ${topicName}`);

    // Reset all state before starting
    setSubscribed(true);
    setStreamHealth({
      framesReceived: 0,
      isStalled: false,
      bufferHealth: "Subscribing...",
    });
    lastFrameTimeRef.current = Date.now();
    chunkQueueRef.current = [];
    isProcessingQueueRef.current = false;
    resetRecoveryState();

    const messageHandler = (msg) => {
      console.log("msg ⏳⚠️🧬🗳🖍💡⚙️🗝", msg.detail);
      try {
        // Support different libp2p event shapes: direct handler (msg.data) or event.detail
        let raw = msg;
        if (msg && msg.detail) raw = msg.detail;
        // Filter by topic if present
        if (raw.topic && raw.topic !== topicName) return;
        // Some implementations wrap data as { data: Uint8Array }
        const dataBytes = raw.data?.data ? raw.data.data : raw.data;
        if (!dataBytes || !(dataBytes instanceof Uint8Array)) return;
        const dataStr = new TextDecoder().decode(dataBytes);
        let parsedMsg;
        try {
          parsedMsg = JSON.parse(dataStr);
        } catch {
          return;
        }
        if (!parsedMsg || !parsedMsg.type) return;
        console.log("parsedMsg ⏳⚠️🧬🗳🖍💡⚙️🗝", parsedMsg);
        if (debugLogRef.current && parsedMsg.type !== "hb") {
          console.log(
            "[STREAM][RECV]",
            parsedMsg.type,
            parsedMsg.seq !== undefined ? "seq=" + parsedMsg.seq : ""
          );
        }
        if (parsedMsg.type === "init") {
          console.log("[STREAM] Received init segment");
          if (
            currentMimeTypeRef.current !== parsedMsg.mimeType ||
            !mediaSourceRef.current ||
            !sourceBufferRef.current
          ) {
            setMimeType(parsedMsg.mimeType);
            setupMediaSource(parsedMsg.mimeType);
          } else {
            if (debugLogRef.current)
              console.log(
                "[STREAM][INIT] Ignoring duplicate init for same mimeType"
              );
          }
          // Attempt to dial broadcaster over direct protocol for efficient streaming
          try {
            if (
              parsedMsg.from &&
              libp2pState &&
              !videoProtocolPeersRef.current.has(parsedMsg.from)
            ) {
              // Dial only if protocol not already open (track via participants + no existing consumer state)
              if (debugLogRef.current)
                console.log(
                  "[STREAM][PROTO DIAL] Attempting dial to broadcaster",
                  parsedMsg.from
                );
              libp2pState
                .dialProtocol(parsedMsg.from, VIDEO_PROTOCOL)
                .then(({ stream, connection }) => {
                  console.log("🙋‍♀️🙋🙋🏻‍♂👷 libp2pState.dialProtocol ");
                  if (debugLogRef.current)
                    console.log(
                      "[STREAM][PROTO DIAL] Connected to broadcaster for video",
                      connection.remotePeer.toString()
                    );
                  videoProtocolPeersRef.current
                    .add(parsedMsg.from)(
                      // Read incoming binary frames: each frame sent as length(uint32 BE) + payload
                      async () => {
                        let buf = new Uint8Array(0);
                        for await (const chunk of stream.source) {
                          if (!(chunk instanceof Uint8Array)) continue;
                          // concat
                          const merged = new Uint8Array(
                            buf.length + chunk.length
                          );
                          merged.set(buf, 0);
                          merged.set(chunk, buf.length);
                          buf = merged;
                          while (buf.length >= 4) {
                            const frameLen = new DataView(
                              buf.buffer,
                              buf.byteOffset,
                              buf.byteLength
                            ).getUint32(0, false);
                            if (buf.length < 4 + frameLen) break;
                            const frame = buf.slice(4, 4 + frameLen);
                            buf = buf.slice(4 + frameLen);
                            appendChunk(frame.buffer);
                          }
                        }
                        if (debugLogRef.current)
                          console.log(
                            "[STREAM][PROTO DIAL] Stream ended from broadcaster"
                          );
                      }
                    )()
                    .catch((e) =>
                      console.warn("[STREAM][PROTO DIAL] reader error", e)
                    );
                })
                .catch(
                  (e) =>
                    debugLogRef.current &&
                    console.warn("[STREAM][PROTO DIAL] dial failed", e)
                );
            }
          } catch (e) {
            debugLogRef.current &&
              console.warn("[STREAM][PROTO DIAL] unexpected error", e);
          }

          // If an init segment was provided (base64), decode and append it immediately
          if (parsedMsg.b64) {
            try {
              const ab = base64ToBuf(parsedMsg.b64);
              if (ab) {
                console.log(
                  "[STREAM] Appending init segment, bytes=",
                  new Uint8Array(ab).length
                );
                appendChunk(ab);
                // first frame receipt stops aggressive init retries
                if (initRetryIntervalRef.current) {
                  clearInterval(initRetryIntervalRef.current);
                  initRetryIntervalRef.current = null;
                }

                // Set up a recovery timeout to reset MediaSource if no more frames arrive
                mediaSourceResetTimeoutRef.current = setTimeout(() => {
                  const timeSinceLastFrame =
                    Date.now() - lastFrameTimeRef.current;
                  if (timeSinceLastFrame > 8000 && sourceBufferRef.current) {
                    // 8 seconds without frames
                    console.log(
                      "[STREAM][RECOVERY] No frames for 8s, requesting fresh init"
                    );
                    try {
                      const lp = libp2pState;
                      if (lp) {
                        lp.services.pubsub
                          .publish(
                            topicName,
                            new TextEncoder().encode(
                              JSON.stringify({
                                type: "request-init",
                                ts: Date.now(),
                                from: lp.peerId.toString(),
                                recovery: true,
                              })
                            )
                          )
                          .catch(() => {});
                      }
                    } catch (e) {
                      console.warn("[STREAM][RECOVERY] request failed", e);
                    }
                  }
                }, 10000);
              }
            } catch (e) {
              console.warn("[STREAM][RECV INIT] failed to process init b64", e);
            }
          }
          if (parsedMsg.from)
            setParticipants((prev) =>
              prev.includes(parsedMsg.from) ? prev : [...prev, parsedMsg.from]
            );
          return;
        }
        if (parsedMsg.type === "chunk") {
          console.log(
            "messageHandler ⏳⚠️🧬🗳🖍💡⚙️🗝------- chunk",
            parsedMsg.chunk
          );
          setLagMs(Date.now() - parsedMsg.ts);
          if (parsedMsg.seq <= lastSeqRef.current) return;
          lastSeqRef.current = parsedMsg.seq;
          const ab = base64ToBuf(parsedMsg.b64);
          if (debugLogRef.current) {
            console.log("[STREAM][RECV CHUNK]", {
              seq: parsedMsg.seq,
              b64Size: parsedMsg.b64.length,
              lag: Date.now() - parsedMsg.ts,
              preview: hexPreview(ab),
            });
          }
          // If we somehow got a chunk before init (late join race), request init
          if (!sourceBufferRef.current) {
            if (debugLogRef.current)
              console.log(
                "[STREAM][RECV CHUNK] No SourceBuffer yet, requesting init..."
              );
            requestInit("no-init-before-chunk");
          }
          appendChunk(ab);
          if (initRetryIntervalRef.current) {
            clearInterval(initRetryIntervalRef.current);
            initRetryIntervalRef.current = null;
          }
          if (parsedMsg.from)
            setParticipants((prev) =>
              prev.includes(parsedMsg.from) ? prev : [...prev, parsedMsg.from]
            );
        }
      } catch (e) {
        console.error("[STREAM][HANDLER ERROR]", e);
      }
    };

    // Decide subscription strategy based on function arity
    let usedDirectHandler = false;
    try {
      if (
        typeof lp.services.pubsub.subscribe === "function" &&
        lp.services.pubsub.subscribe.length >= 2
      ) {
        console.log(
          "🙋‍♀️🙋🙋🏻‍♂👷[STREAM][SUBSCRIBE] using handler argument form"
        );
        await lp.services.pubsub.subscribe(topicName, messageHandler);
        usedDirectHandler = true;
      }
    } catch (e) {
      console.log(
        "[STREAM][SUBSCRIBE] direct handler subscribe failed, will fallback",
        e
      );
    }
    console.log("----------------", usedDirectHandler);
    if (!usedDirectHandler) {
      // Fallback to event listener pattern
      lp.services.pubsub.removeEventListener("message", messageHandler);
      lp.services.pubsub.addEventListener("message", messageHandler);
      await lp.services.pubsub.subscribe(topicName);
    }
    console.log("[STREAM][SUBSCRIBE] subscribe() call finished");

    // Aggressively request init segment until first media appended or timeout
    let initAttempts = 0;
    if (initRetryIntervalRef.current) {
      clearInterval(initRetryIntervalRef.current);
    }
    initRetryIntervalRef.current = setInterval(() => {
      if (framesReceivedRef.current > 0 || sourceBufferRef.current) {
        clearInterval(initRetryIntervalRef.current);
        initRetryIntervalRef.current = null;
        return;
      }
      if (initAttempts >= 10) {
        // stop after ~10 attempts (~10s)
        clearInterval(initRetryIntervalRef.current);
        initRetryIntervalRef.current = null;
        return;
      }
      initAttempts++;
      requestInit("aggressive-startup-" + initAttempts);
    }, 1000);
    requestInit("initial-subscribe");

    // Start stream health monitoring
    streamHealthIntervalRef.current &&
      clearInterval(streamHealthIntervalRef.current);
    streamHealthIntervalRef.current = setInterval(() => {
      if (!videoRef.current || videoRef.current.paused) {
        return;
      }

      const isStalled = Date.now() - lastFrameTimeRef.current > 3000;
      setStreamHealth((prev) => ({ ...prev, isStalled }));

      if (!isStalled) {
        // If not stalled, make sure recovery flags are reset
        resetRecoveryState();
        return;
      }

      // Multi-stage recovery
      if (
        Date.now() - lastFrameTimeRef.current > 12000 &&
        !recoveryStateRef.current.isReconnecting
      ) {
        console.error(
          `[STREAM][RECOVERY] Stage 3: Stall detected for >12s. Performing full re-subscription.`
        );
        recoveryStateRef.current.isReconnecting = true; // Prevent multiple concurrent recoveries
        setStreamHealth((prev) => ({
          ...prev,
          isStalled: true,
          bufferHealth: "Reconnecting...",
        }));

        // Unsubscribe and re-subscribe to fully reset
        unsubscribe().then(() => {
          setTimeout(() => {
            console.log("[STREAM][RECOVERY] Re-subscribing now...");
            subscribe();
            // Note: recoveryStateRef is reset inside subscribe()
          }, 500); // Brief delay before re-subscribing
        });
      } else if (
        Date.now() - lastFrameTimeRef.current > 8000 &&
        !recoveryStateRef.current.isRestartingICE
      ) {
        console.warn(
          `[STREAM][RECOVERY] Stage 2: Stall detected for >8s. Attempting ICE restart.`
        );
        recoveryStateRef.current.isRestartingICE = true;
        setStreamHealth((prev) => ({
          ...prev,
          bufferHealth: "Restarting Connection...",
        }));
        if (peerConnectionRef.current && connectionType === "webrtc") {
          peerConnectionRef.current.restartIce();
          console.log("[STREAM][RECOVERY] ICE restart initiated.");
        }
        // Also request init just in case
        requestInit("ice-restart-recovery");
      } else if (
        Date.now() - lastFrameTimeRef.current > 5000 &&
        !recoveryStateRef.current.isRequestingInit
      ) {
        console.warn(
          `[STREAM][RECOVERY] Stage 1: Stall detected for >5s. Requesting new init segment.`
        );
        recoveryStateRef.current.isRequestingInit = true;
        setStreamHealth((prev) => ({
          ...prev,
          bufferHealth: "Requesting Keyframe...",
        }));
        requestInit("stall-recovery");
      }
    }, 2000);

    return () => {
      if (streamHealthIntervalRef.current) {
        clearInterval(streamHealthIntervalRef.current);
        streamHealthIntervalRef.current = null;
      }
      if (initRetryIntervalRef.current) {
        clearInterval(initRetryIntervalRef.current);
        initRetryIntervalRef.current = null;
      }
      lp.services.pubsub.removeEventListener("message", messageHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unsubscribe = useCallback(async () => {
    console.log(`[STREAM] Unsubscribing from topic: ${topicName}`);
    const lp = libp2pState;
    if (!lp || !subscribed) return;
    try {
      await lp.services.pubsub.unsubscribe(topicName);
      videoProtocolPeersRef.current.clear();
      if (initRetryIntervalRef.current) {
        clearInterval(initRetryIntervalRef.current);
        initRetryIntervalRef.current = null;
      }
      framesReceivedRef.current = 0;

      // Clean up WebRTC connections
      for (const [peerId, pc] of peerConnectionsRef.current) {
        try {
          pc.close();
          if (debugLogRef.current)
            console.log(
              "[WEBRTC] Closed connection during unsubscribe to",
              peerId
            );
        } catch (e) {
          console.warn(
            "[WEBRTC] Error closing connection during unsubscribe to",
            peerId,
            e
          );
        }
      }
      peerConnectionsRef.current.clear();
      dataChannelsRef.current.clear();
      setWebrtcConnections([]);

      // Stop stream health monitoring
      streamHealthIntervalRef.current &&
        clearInterval(streamHealthIntervalRef.current);
      setStreamHealth({
        framesReceived: 0,
        lastFrameTime: 0,
        isStalled: false,
        bufferHealth: "unknown",
      });

      // Clean up MediaSource pipeline
      resetMediaSourcePipeline();

      setSubscribed(false);
      showMsg("Unsubscribed", "info");
    } catch (e) {
      console.error(e);
    }
  }, [libp2pState, topicName, resetMediaSourcePipeline, subscribed]);

  // Track peers
  useEffect(() => {
    if (!libp2pState) return;
    const updatePeers = () => setPeerCount(libp2pState.getPeers().length);
    updatePeers();
    statIntervalRef.current = setInterval(updatePeers, 5000);
    connIntervalRef.current = setInterval(() => {
      try {
        setConnectionsSnapshot(
          libp2pState
            .getConnections()
            .map((c) => ({
              id: c.remotePeer.toString(),
              streams: c.streams.length,
              status: c.status,
            }))
        );
      } catch {}
    }, 4000);
    return () => clearInterval(statIntervalRef.current);
  }, [libp2pState]);

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

  const connectToManualPeer = async () => {
    setManualConnectMsg("");
    const target = manualPeerId.trim();
    if (!target) {
      setManualConnectMsg("Enter peer id");
      return;
    }
    const lp = await ensureLibp2p();
    if (!lp) {
      setManualConnectMsg("Libp2p not ready");
      return;
    }
    // ensure bootstrap connection first
    try {
      const bootstrapAddr = BOOTSTRAP_MULTIADDRS[0];
      if (bootstrapAddr) {
        const relayPeerId = bootstrapAddr.split("/p2p/")[1];
        const connectedIds = lp
          .getConnections()
          .map((c) => c.remotePeer.toString());
        if (relayPeerId && !connectedIds.includes(relayPeerId)) {
          await lp.dial(multiaddr(bootstrapAddr));
        }
      }
    } catch (e) {
      console.warn("Bootstrap ensure failed (manual connect)", e);
    }

    // Try WebRTC connection first if enabled
    if (useWebRTC && connectionType === "webrtc") {
      try {
        setManualConnectMsg("Attempting WebRTC connection...");
        await initiateWebRTCConnection(target);
        setManualConnectMsg("WebRTC connection initiated");
        return;
      } catch (e) {
        setManualConnectMsg("WebRTC failed, trying libp2p...");
        console.warn("WebRTC connection failed", e);
      }
    }

    // Build candidate relay addresses
    let candidates = [];
    try {
      const relayMa = BOOTSTRAP_MULTIADDRS[0];
      if (relayMa) {
        const base = relayMa;
        candidates.push(base + `/p2p-circuit/p2p/${target}`);
        candidates.push(base + `/p2p-circuit/webrtc/p2p/${target}`);
      }
    } catch {}
    // Fallback direct forms (may succeed if we have discovered their addresses)
    candidates.push(`/p2p/${target}`);
    let success = false;
    console.log(candidates);
    for (const c of candidates) {
      try {
        console.log("[STREAM][MANUAL DIAL] attempting", c);
        await lp.dial(multiaddr(c));
        success = true;
        setManualConnectMsg("Connected (or dial initiated) via " + c);
        break;
      } catch (e) {
        console.warn("dial failed", c, e.message || e);
        setManualConnectMsg("Failed attempt: " + c);
      }
    }
    if (!success)
      setManualConnectMsg((prev) => prev + " | All candidates failed");
  };

  return (
    <>
      <div>
        <h2>Enter peer address to connect</h2>
        <input
          type="text"
          value={manualPeerId}
          onChange={(e) => setManualPeerId(e.target.value)}
          placeholder="Type peer ID to connect"
        />
        <p>
          {name
            ? `will connect, ${manualPeerId}!`
            : "Please enter remote peer ID"}
        </p>
        <button size="small" variant="contained" onClick={connectToManualPeer}>
          Connect manual peer
        </button>
        <p>{selfPeerId}</p>
        <p>
          {libp2pState ? "Libp2p Connected" : "Libp2p Disconnected"} 🧞🇹🇼{" "}
          {manualConnectMsg}{" "}
        </p>
        <p>{participants}</p>
        <h3>🌈 {snackbar.message}</h3>
        <p>Local Peer:🚀 {localPeer}</p>
        <button onClick={startBroadcast}>Broadcast</button>
        <button onClick={stopBroadcast}>Stop Broadcast</button>
        <video
          ref={videoLocalRef}
          autoPlay
          muted
          playsInline
          style={{ width: "100%", borderRadius: 8, background: "#000" }}
        />
        {!subscribed ? (
          <button
            onClick={subscribe}
            disabled={broadcasting || initializing || !libp2pState}
          >
            View
          </button>
        ) : (
          <button variant="outlined" color="warning" onClick={unsubscribe}>
            Leave
          </button>
        )}

        <video
          ref={videoRemoteRef}
          autoPlay
          playsInline
          muted={remoteMuted}
          controls={!broadcasting && subscribed}
          style={{ width: "100%", borderRadius: 8, background: "#000" }}
        />
        {subscribed && (
          <button
            size="small"
            sx={{ mt: 1 }}
            variant="outlined"
            onClick={() => {
              setRemoteMuted((m) => !m);
              if (videoRemoteRef.current) {
                videoRemoteRef.current.muted = !remoteMuted;
                videoRemoteRef.current.play().catch(() => {});
              }
            }}
          >
            {remoteMuted ? "Unmute" : "Mute"}
          </button>
        )}
      </div>
    </>
  );
}

export default StreamPage;
