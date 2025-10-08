import { useState, useCallback, useEffect, useRef } from "react";
import { startLibp2pNode } from "../services/libp2p-services";
import { useLibp2p } from "../contexts/Libp2pContext";
import "../App.css";
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
	const [useWebRTC, setUseWebRTC] = useState(true)
	const [webrtcConnections, setWebrtcConnections] = useState([])
	const [publisherPeerId, setPublisherPeerId] = useState('') // Add publisherPeerId state

  const stopBroadcast = async () => {
		if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
			mediaRecorderRef.current.stop()
		}
		// stop tracks only for camera streams; if using file captureStream, avoid stopping the file playback
		if (localStreamRef.current) {
			try {
				localStreamRef.current.getTracks().forEach(t => t.stop())
			} catch (e) { /* ignore */ }
			localStreamRef.current = null
		}
		// cleanup selected file object URL
		if (fileUrlRef.current) {
			try { URL.revokeObjectURL(fileUrlRef.current) } catch (e) {}
			fileUrlRef.current = null
			setSelectedFile(null)
			if (videoLocalRef.current) videoLocalRef.current.src = ''
		}
		// cleanup WebRTC connections
		for (const [peerId, pc] of peerConnectionsRef.current) {
			try {
				pc.close()
				if (debugLogRef.current) console.log('[WEBRTC] Closed connection to', peerId)
			} catch (e) {
				console.warn('[WEBRTC] Error closing connection to', peerId, e)
			}
		}
		peerConnectionsRef.current.clear()
		dataChannelsRef.current.clear()
		webrtcStreamRef.current = null
		setWebrtcConnections([])
		
		reinitIntervalRef.current && clearInterval(reinitIntervalRef.current)
		heartbeatIntervalRef.current && clearInterval(heartbeatIntervalRef.current)
		setBroadcasting(false)
		showMsg('Broadcast stopped', 'info')
	}

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
          console.log(bootstrapPeerId)
          console.log(connectedIds)
        if (bootstrapPeerId && !connectedIds.includes(bootstrapPeerId)) {
          try {
            showMsg("Connecting to bootstrap node...", "info");
            await lp.dial(multiaddr(bootstrapAddr));
            connectedIds = lp
              .getConnections()
              .map((c) => c.remotePeer.toString());
          } catch (e) {
            console.warn("Bootstrap dial attempt failed", e);
          }
        }
        if (!connectedIds.includes(bootstrapPeerId)) {
          showMsg("Cannot broadcast: not connected to bootstrap node", "error");
          return;
        }
      }
      if (!selfPeerId) {
        try {
          setSelfPeerId(lp.peerId.toString());
        } catch {}
      }
      // Build mediaStream according to sourceMode
      let mediaStream = null;
      if (sourceMode === "camera") {
        const constraints = { audio: true, video: { width: 640, height: 360 } };
        mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (videoLocalRef.current)
          videoLocalRef.current.srcObject = mediaStream;
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
		console.log('[STREAM][DEBUG] Subscribe button clicked')
		let lp = libp2pState;
		console.log('[STREAM][DEBUG] libp2pState:', lp ? 'exists' : 'null/undefined')
		console.log('[STREAM][DEBUG] subscribed:', subscribed)
		console.log('[STREAM][DEBUG] topicName:', topicName)

		// Try to initialize libp2p if not connected
		if (!lp) {
			console.log('[STREAM][DEBUG] No libp2p instance, attempting to initialize...')
			lp = await ensureLibp2p()
			if (!lp) {
				console.error('[STREAM][DEBUG] Failed to initialize libp2p')
				showMsg('Failed to connect to libp2p network. Please try connecting manually first.', 'error')
				return
			}
		}

		if (subscribed) {
			console.log('[STREAM][DEBUG] Already subscribed, ignoring')
			return
		}

		console.log(`[STREAM] Subscribing to topic: ${topicName}`);
		
		// Reset all state before starting
		setSubscribed(true);
		setStreamHealth({ framesReceived: 0, isStalled: false, bufferHealth: 'Subscribing...' });
		lastFrameTimeRef.current = Date.now();
		chunkQueueRef.current = [];
		isProcessingQueueRef.current = false;
		resetRecoveryState();

		const messageHandler = (msg) => {
			try {
				// Support different libp2p event shapes: direct handler (msg.data) or event.detail
				let raw = msg
				if (msg && msg.detail) raw = msg.detail
				// Filter by topic if present
				if (raw.topic && raw.topic !== topicName) return
				// Some implementations wrap data as { data: Uint8Array }
				const dataBytes = raw.data?.data ? raw.data.data : raw.data
				if (!dataBytes || !(dataBytes instanceof Uint8Array)) return
				const dataStr = new TextDecoder().decode(dataBytes)
				let parsedMsg
				try { parsedMsg = JSON.parse(dataStr) } catch { return }
				if (!parsedMsg || !parsedMsg.type) return
				if (debugLogRef.current && parsedMsg.type !== 'hb') {
					console.log('[STREAM][RECV]', parsedMsg.type, parsedMsg.seq !== undefined ? 'seq='+parsedMsg.seq : '')
				}
				if (parsedMsg.type === 'init') {
					console.log('[STREAM] Received init segment');
					if (currentMimeTypeRef.current !== parsedMsg.mimeType || !mediaSourceRef.current || !sourceBufferRef.current) {
						setMimeType(parsedMsg.mimeType)
						setupMediaSource(parsedMsg.mimeType)
					} else {
						if (debugLogRef.current) console.log('[STREAM][INIT] Ignoring duplicate init for same mimeType')
					}
					// Attempt to dial broadcaster over direct protocol for efficient streaming
					try {
						if (parsedMsg.from && libp2pState && !videoProtocolPeersRef.current.has(parsedMsg.from)) {
							// Dial only if protocol not already open (track via participants + no existing consumer state)
							if (debugLogRef.current) console.log('[STREAM][PROTO DIAL] Attempting dial to broadcaster', parsedMsg.from)
							libp2pState.dialProtocol(parsedMsg.from, VIDEO_PROTOCOL).then(({ stream, connection }) => {
								if (debugLogRef.current) console.log('[STREAM][PROTO DIAL] Connected to broadcaster for video', connection.remotePeer.toString())
								videoProtocolPeersRef.current.add(parsedMsg.from)
								// Read incoming binary frames: each frame sent as length(uint32 BE) + payload
								(async () => {
									let buf = new Uint8Array(0)
									for await (const chunk of stream.source) {
										if (!(chunk instanceof Uint8Array)) continue
										// concat
										const merged = new Uint8Array(buf.length + chunk.length)
										merged.set(buf, 0); merged.set(chunk, buf.length)
										buf = merged
										while (buf.length >= 4) {
											const frameLen = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false)
											if (buf.length < 4 + frameLen) break
											const frame = buf.slice(4, 4 + frameLen)
											buf = buf.slice(4 + frameLen)
											appendChunk(frame.buffer)
										}
									}
									if (debugLogRef.current) console.log('[STREAM][PROTO DIAL] Stream ended from broadcaster')
								})().catch(e => console.warn('[STREAM][PROTO DIAL] reader error', e))
							}).catch(e => debugLogRef.current && console.warn('[STREAM][PROTO DIAL] dial failed', e))
						}
					} catch (e) { debugLogRef.current && console.warn('[STREAM][PROTO DIAL] unexpected error', e) }
					
					// If an init segment was provided (base64), decode and append it immediately
					if (parsedMsg.b64) {
						try {
							const ab = base64ToBuf(parsedMsg.b64)
							if (ab) {
								console.log('[STREAM] Appending init segment, bytes=', new Uint8Array(ab).length)
								appendChunk(ab)
								// first frame receipt stops aggressive init retries
								if (initRetryIntervalRef.current) { clearInterval(initRetryIntervalRef.current); initRetryIntervalRef.current = null }
								
								// Set up a recovery timeout to reset MediaSource if no more frames arrive
								mediaSourceResetTimeoutRef.current = setTimeout(() => {
									const timeSinceLastFrame = Date.now() - lastFrameTimeRef.current
									if (timeSinceLastFrame > 8000 && sourceBufferRef.current) { // 8 seconds without frames
										console.log('[STREAM][RECOVERY] No frames for 8s, requesting fresh init')
										try {
											const lp = libp2pState
											if (lp) {
												lp.services.pubsub.publish(topicName, new TextEncoder().encode(JSON.stringify({ type: 'request-init', ts: Date.now(), from: lp.peerId.toString(), recovery: true }))).catch(()=>{})
											}
										} catch (e) { console.warn('[STREAM][RECOVERY] request failed', e) }
									}
								}, 10000)
							}
						} catch (e) { console.warn('[STREAM][RECV INIT] failed to process init b64', e) }
					}
					if (parsedMsg.from) setParticipants(prev => prev.includes(parsedMsg.from) ? prev : [...prev, parsedMsg.from])
					return
				}
				if (parsedMsg.type === 'chunk') {
					setLagMs(Date.now() - parsedMsg.ts)
					if (parsedMsg.seq <= lastSeqRef.current) return
					lastSeqRef.current = parsedMsg.seq
					const ab = base64ToBuf(parsedMsg.b64)
					if (debugLogRef.current) {
						console.log('[STREAM][RECV CHUNK]', { seq: parsedMsg.seq, b64Size: parsedMsg.b64.length, lag: Date.now() - parsedMsg.ts, preview: hexPreview(ab) })
					}
					// If we somehow got a chunk before init (late join race), request init
					if (!sourceBufferRef.current) {
						if (debugLogRef.current) console.log('[STREAM][RECV CHUNK] No SourceBuffer yet, requesting init...')
						requestInit('no-init-before-chunk')
					}
					appendChunk(ab)
					if (initRetryIntervalRef.current) { clearInterval(initRetryIntervalRef.current); initRetryIntervalRef.current = null }
					if (parsedMsg.from) setParticipants(prev => prev.includes(parsedMsg.from) ? prev : [...prev, parsedMsg.from])
				}
			} catch (e) {
				console.error('[STREAM][HANDLER ERROR]', e)
			}
		}

		// Decide subscription strategy based on function arity
		let usedDirectHandler = false
		try {
			if (typeof lp.services.pubsub.subscribe === 'function' && lp.services.pubsub.subscribe.length >= 2) {
				console.log('[STREAM][SUBSCRIBE] using handler argument form')
				await lp.services.pubsub.subscribe(topicName, messageHandler)
				usedDirectHandler = true
			}
		} catch (e) { console.log('[STREAM][SUBSCRIBE] direct handler subscribe failed, will fallback', e) }
		if (!usedDirectHandler) {
			// Fallback to event listener pattern
			lp.services.pubsub.removeEventListener('message', messageHandler)
			lp.services.pubsub.addEventListener('message', messageHandler)
			await lp.services.pubsub.subscribe(topicName)
		}
		console.log('[STREAM][SUBSCRIBE] subscribe() call finished')

		// Aggressively request init segment until first media appended or timeout
		let initAttempts = 0
		if (initRetryIntervalRef.current) { clearInterval(initRetryIntervalRef.current) }
		initRetryIntervalRef.current = setInterval(() => {
			if (framesReceivedRef.current > 0 || sourceBufferRef.current) {
				clearInterval(initRetryIntervalRef.current); initRetryIntervalRef.current = null; return
			}
			if (initAttempts >= 10) { // stop after ~10 attempts (~10s)
				clearInterval(initRetryIntervalRef.current); initRetryIntervalRef.current = null; return
			}
			initAttempts++
			requestInit('aggressive-startup-'+initAttempts)
		}, 1000)
		requestInit('initial-subscribe')
		
		// Start stream health monitoring
		streamHealthIntervalRef.current && clearInterval(streamHealthIntervalRef.current)
		streamHealthIntervalRef.current = setInterval(() => {
			if (!videoRef.current || videoRef.current.paused) {
				return;
			}

			const isStalled = Date.now() - lastFrameTimeRef.current > 3000;
			setStreamHealth(prev => ({ ...prev, isStalled }));

			if (!isStalled) {
				// If not stalled, make sure recovery flags are reset
				resetRecoveryState();
				return;
			}
			
			// Multi-stage recovery
			if (Date.now() - lastFrameTimeRef.current > 12000 && !recoveryStateRef.current.isReconnecting) {
				console.error(`[STREAM][RECOVERY] Stage 3: Stall detected for >12s. Performing full re-subscription.`);
				recoveryStateRef.current.isReconnecting = true; // Prevent multiple concurrent recoveries
				setStreamHealth(prev => ({ ...prev, isStalled: true, bufferHealth: 'Reconnecting...' }));
				
				// Unsubscribe and re-subscribe to fully reset
				unsubscribe().then(() => {
					setTimeout(() => {
						console.log('[STREAM][RECOVERY] Re-subscribing now...');
						subscribe();
						// Note: recoveryStateRef is reset inside subscribe()
					}, 500); // Brief delay before re-subscribing
				});

			} else if (Date.now() - lastFrameTimeRef.current > 8000 && !recoveryStateRef.current.isRestartingICE) {
				console.warn(`[STREAM][RECOVERY] Stage 2: Stall detected for >8s. Attempting ICE restart.`);
				recoveryStateRef.current.isRestartingICE = true;
				setStreamHealth(prev => ({ ...prev, bufferHealth: 'Restarting Connection...' }));
				if (peerConnectionRef.current && connectionType === 'webrtc') {
					peerConnectionRef.current.restartIce();
					console.log('[STREAM][RECOVERY] ICE restart initiated.');
				}
				// Also request init just in case
				requestInit('ice-restart-recovery');

			} else if (Date.now() - lastFrameTimeRef.current > 5000 && !recoveryStateRef.current.isRequestingInit) {
				console.warn(`[STREAM][RECOVERY] Stage 1: Stall detected for >5s. Requesting new init segment.`);
				recoveryStateRef.current.isRequestingInit = true;
				setStreamHealth(prev => ({ ...prev, bufferHealth: 'Requesting Keyframe...' }));
				requestInit('stall-recovery');
			}

		}, 2000);

		return () => {
			if (streamHealthIntervalRef.current) {
				clearInterval(streamHealthIntervalRef.current)
				streamHealthIntervalRef.current = null
			}
			if (initRetryIntervalRef.current) { clearInterval(initRetryIntervalRef.current); initRetryIntervalRef.current = null }
			lp.services.pubsub.removeEventListener('message', messageHandler);
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

  // Reset MediaSource pipeline when SourceBuffer becomes invalid
	const resetMediaSourcePipeline = useCallback(() => {
		try {
			console.log('[STREAM][RESET] Resetting MediaSource pipeline')
			
			// Clear timeouts
			if (mediaSourceResetTimeoutRef.current) {
				clearTimeout(mediaSourceResetTimeoutRef.current)
				mediaSourceResetTimeoutRef.current = null
			}
			
			// Store current pending buffers to early buffers
			if (pendingBuffersRef.current.length > 0) {
				earlyBuffersRef.current.push(...pendingBuffersRef.current)
				pendingBuffersRef.current = []
			}
			
			// Clean up current MediaSource
			if (sourceBufferRef.current) {
				sourceBufferRef.current = null
			}
			
			if (mediaSourceRef.current) {
				try {
					if (mediaSourceRef.current.readyState === 'open') {
						console.log('[STREAM][RESET] (skip endOfStream to avoid premature close)')
						// intentionally NOT calling endOfStream here to prevent auto-closing during active playback
					}
				} catch (e) { /* ignore */ }
				mediaSourceRef.current = null
			}
			
			if (videoRemoteRef.current) {
				try {
					URL.revokeObjectURL(videoRemoteRef.current.src)
					videoRemoteRef.current.src = ''
				} catch (e) { /* ignore */ }
			}
			
			// Reset flags
			firstRemoteFrameRef.current = false
			
			// Re-setup MediaSource if we have a mimeType
			if (mimeType) {
				setTimeout(() => {
					console.log('[STREAM][RESET] Re-setting up MediaSource after reset')
					if (!('MediaSource' in window)) {
						console.error('[STREAM][RESET] MediaSource API not supported')
						return
					}
					
					const ms = new MediaSource()
					mediaSourceRef.current = ms
					videoRemoteRef.current.src = URL.createObjectURL(ms)
					
					ms.addEventListener('sourceopen', () => {
						try {
							if (ms !== mediaSourceRef.current || ms.readyState !== 'open') {
								console.warn('[STREAM][RESET] MediaSource state changed during reset sourceopen')
								return
							}
							
							const sb = ms.addSourceBuffer(mimeType)
							console.log('[STREAM][RESET] SourceBuffer recreated with mimeType=', mimeType)
							
							sourceBufferRef.current = sb
							sb.mode = 'sequence'
							
							// Re-attach event listeners
							sb.addEventListener('updateend', () => {
								const currentSb = sourceBufferRef.current
								const currentMs = mediaSourceRef.current
								
								if (!currentSb || !currentMs || currentMs.readyState !== 'open' || !Array.from(currentMs.sourceBuffers).includes(currentSb)) {
									return
								}
								
								if (pendingBuffersRef.current.length > 0 && !currentSb.updating) {
									const next = pendingBuffersRef.current.shift()
									if (next) {
										try {
											currentSb.appendBuffer(next)
										} catch (e) {
											console.error('[STREAM][RESET UPDATEEND] Failed to append buffer', e)
										}
									}
								}
								
								if (!firstRemoteFrameRef.current && videoRemoteRef.current && videoRemoteRef.current.readyState >= 2) {
									firstRemoteFrameRef.current = true
									videoRemoteRef.current.play().catch(()=>{})
								}
							})
							
							// Process early buffers
							if (earlyBuffersRef.current.length) {
								console.log('[STREAM][RESET] Processing early buffers count=', earlyBuffersRef.current.length)
								while (earlyBuffersRef.current.length) {
									const buf = earlyBuffersRef.current.shift()
									try {
										if (!sb.updating && ms.readyState === 'open') {
											sb.appendBuffer(buf)
										} else {
											pendingBuffersRef.current.push(buf)
										}
									} catch (e) { 
										console.error('[STREAM][RESET] Failed to append early buffer', e)
										pendingBuffersRef.current.push(buf)
									}
								}
							}
						} catch (err) {
							console.error('[STREAM][RESET] Error setting up reset SourceBuffer', err)
						}
					})
				}, 100)
			}
			
		} catch (e) {
			console.error('[STREAM][RESET] Error during MediaSource reset', e)
		}
	}, [mimeType])


	const unsubscribe = useCallback(async () => {
		console.log(`[STREAM] Unsubscribing from topic: ${topicName}`)
		const lp = libp2pState
		if (!lp || !subscribed) return
		try {
			await lp.services.pubsub.unsubscribe(topicName)
			videoProtocolPeersRef.current.clear()
			if (initRetryIntervalRef.current) { clearInterval(initRetryIntervalRef.current); initRetryIntervalRef.current = null }
			framesReceivedRef.current = 0
			
			// Clean up WebRTC connections
			for (const [peerId, pc] of peerConnectionsRef.current) {
				try {
					pc.close()
					if (debugLogRef.current) console.log('[WEBRTC] Closed connection during unsubscribe to', peerId)
				} catch (e) {
					console.warn('[WEBRTC] Error closing connection during unsubscribe to', peerId, e)
				}
			}
			peerConnectionsRef.current.clear()
			dataChannelsRef.current.clear()
			setWebrtcConnections([])
			
			// Stop stream health monitoring
			streamHealthIntervalRef.current && clearInterval(streamHealthIntervalRef.current)
			setStreamHealth({
				framesReceived: 0,
				lastFrameTime: 0,
				isStalled: false,
				bufferHealth: 'unknown'
			})
			
			// Clean up MediaSource pipeline
			resetMediaSourcePipeline()
			
			setSubscribed(false)
			showMsg('Unsubscribed', 'info')
		} catch (e) {
			console.error(e)
		}
	}, [libp2pState, topicName, resetMediaSourcePipeline, subscribed])

	
	// Track peers
	useEffect(() => {
		if (!libp2pState) return
		const updatePeers = () => setPeerCount(libp2pState.getPeers().length)
		updatePeers()
		statIntervalRef.current = setInterval(updatePeers, 5000)
		connIntervalRef.current = setInterval(() => {
			try {
				setConnectionsSnapshot(libp2pState.getConnections().map(c => ({ id: c.remotePeer.toString(), streams: c.streams.length, status: c.status })))
			} catch {}
		}, 4000)
		return () => clearInterval(statIntervalRef.current)
	}, [libp2pState])

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
        <h3>🌈 {snackbar.message}</h3>
        <p>Local Peer:🚀 {localPeer}</p>
        <button onClick={startBroadcast}>Broadcast</button>
         <button onClick={stopBroadcast}>
          Stop Broadcast</button>
          {!subscribed ? (
											<button
												onClick={subscribe}
												disabled={broadcasting || initializing || !libp2pState}
											>View</button>
										) : (
											<button variant="outlined" color="warning" onClick={unsubscribe}>Leave</button>
										)}
      </div>
    </>
  );
}

export default StreamPage;
