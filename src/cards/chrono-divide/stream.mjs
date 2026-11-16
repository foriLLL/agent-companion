// 不使用公网 STUN/TURN，两端都在同一台机器上。两端在交换 SDP 前收齐候选地址。
export async function gatherIce(peer) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", change); resolve(); };
    const change = () => { if (peer.iceGatheringState === "complete") done(); };
    const timer = setTimeout(done, 2500);
    peer.addEventListener("icegatheringstatechange", change);
  });
}

// 独立运行在无窗口浏览器的游戏文档中。只采集当前游戏标签的合成画面和音轨。
export async function answerGameStream(offer, gather) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser", frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1200 } },
    audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude",
    systemAudio: "exclude", monitorTypeSurfaces: "exclude"
  });
  if (stream.getVideoTracks()[0]?.getSettings().displaySurface !== "browser") {
    stream.getTracks().forEach(track => track.stop());
    throw new Error("无法采集独立游戏页面。");
  }
  const peer = new RTCPeerConnection({ iceServers: [] });
  // 保持发送端存活，关闭独立进程或重载文档时 Chromium 收回全部轨道。
  window.__companionGameStream = peer;
  for (const track of stream.getTracks()) peer.addTrack(track, stream);
  const videoTrack = stream.getVideoTracks()[0];
  const sender = peer.getSenders().find(item => item.track === videoTrack);
  // 直送画面期间释放视频编码器，音轨保持原状。媒体入口不可用时恢复同一个发送端。
  window.__companionSetGameVideo = async enabled => {
    videoTrack.enabled = enabled;
    await sender.replaceTrack(enabled ? videoTrack : null);
  };
  await peer.setRemoteDescription(offer);
  await peer.setLocalDescription(await peer.createAnswer());
  await gather(peer);
  return peer.localDescription.toJSON();
}

// 两端位于同一台机器。只交换环回 UDP 候选，避免依赖 VPN 或 mDNS 解析本机名称。
export function loopbackDescription({ type, sdp }) {
  const lines = sdp.split(/\r?\n/).flatMap(line => {
    if (!line.startsWith("a=candidate:")) return [line];
    const fields = line.split(" ");
    if (fields[2]?.toLowerCase() !== "udp" || fields[6] !== "typ" || fields[7] !== "host") return [];
    fields[4] = "127.0.0.1";
    return [fields.join(" ")];
  });
  return { type, sdp: lines.join("\r\n") };
}
