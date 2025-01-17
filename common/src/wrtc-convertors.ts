import { RTCAVSignalingOfferSetup, RTCAVMessage, FFMpegInput, MediaManager, ScryptedMimeTypes, MediaObject } from "@scrypted/sdk/types";
import child_process from 'child_process';
import net from 'net';
import { listenZero, listenZeroSingleClient } from "./listen-cluster";
import { ffmpegLogInitialOutput } from "./media-helpers";
import sdk from "@scrypted/sdk";

const { mediaManager, endpointManager, deviceManager } = sdk;

const configuration: RTCConfiguration = {
  iceServers: [
    {
      urls: ["turn:turn0.clockworkmod.com", "turn:n0.clockworkmod.com", "turn:n1.clockworkmod.com"],
      username: "foo",
      credential: "bar",
    },
  ],
};

let wrtc: any;
function initalizeWebRtc() {
  if (wrtc)
    return;
  try {
    wrtc = require('wrtc');
  }
  catch (e) {
    console.warn('loading wrtc failed. trying @koush/wrtc fallback.');
    wrtc = require('@koush/wrtc');
  }

  Object.assign(global, wrtc);
}

interface RTCSession {
  pc: RTCPeerConnection;
  pendingCandidates: RTCIceCandidate[];
  resolve?: (value: any) => void;
}

export function addBuiltins(console: Console, mediaManager: MediaManager) {
  // older scrypted runtime won't have this property, and wrtc will be built in.
  if (!mediaManager.builtinConverters)
    return;

  const rtcSessions: { [id: string]: RTCSession } = {};
  mediaManager.builtinConverters.push({
    fromMimeType: ScryptedMimeTypes.RTCAVAnswer,
    toMimeType: ScryptedMimeTypes.RTCAVOffer,
    async convert(data: Buffer, fromMimeType: string): Promise<Buffer> {
      const rtcInput: RTCAVMessage = JSON.parse(data.toString());
      const { id } = rtcInput;
      const session = rtcSessions[id];
      const pc = rtcSessions[id].pc;
      let pendingCandidates: RTCIceCandidateInit[] = [];

      // safari sends the candidates before the RTC Answer? watch for that.
      if (!pc.remoteDescription) {
        if (!rtcInput.description) {
          // can't do anything with this yet, candidates out of order.
          pendingCandidates.push(...(rtcInput.candidates || []));
        }
        else {
          await pc.setRemoteDescription(rtcInput.description);
          if (!rtcInput.candidates)
            rtcInput.candidates = [];
          rtcInput.candidates.push(...pendingCandidates);
          pendingCandidates = [];
        }
      }

      if (pc.remoteDescription && rtcInput.candidates?.length) {
        for (const candidate of rtcInput.candidates) {
          pc.addIceCandidate(candidate);
        }
      }
      else if (!session.pendingCandidates.length) {
        // wait for candidates to come in.
        await new Promise(resolve => session.resolve = resolve);
      }
      const ret: RTCAVMessage = {
        id,
        candidates: session.pendingCandidates,
        description: null,
        configuration: null,
      };
      session.pendingCandidates = [];
      return Buffer.from(JSON.stringify(ret));
    }
  });

  mediaManager.builtinConverters.push({
    fromMimeType: ScryptedMimeTypes.FFmpegInput,
    toMimeType: ScryptedMimeTypes.RTCAVOffer,
    async convert(ffInputBuffer: Buffer, fromMimeType: string): Promise<Buffer> {
      const ffInput: FFMpegInput = JSON.parse(ffInputBuffer.toString());

      const pc = await startRTCPeerConnectionFFmpegInput(ffInput);
      const id = Math.random().toString();
      const session: RTCSession = {
        pc,
        pendingCandidates: [],
      };
      rtcSessions[id] = session;

      pc.onicecandidate = evt => {
        if (evt.candidate) {
          // console.log('local candidate', evt.candidate);
          session.pendingCandidates.push(evt.candidate);
          session.resolve?.(null);
        }
      }

      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);

      const ret: RTCAVMessage = {
        id,
        candidates: [],
        description: offer,
        configuration,
      }

      return Buffer.from(JSON.stringify(ret));
    }
  })
}

export interface RTCPeerConnectionMediaObjectSession {
  pc: RTCPeerConnection;
  answer: RTCAVMessage;
}

export async function getRTCSignalingOfferSetup(mediaObject: MediaObject): Promise<RTCAVSignalingOfferSetup> {
  const buffer = await mediaManager.convertMediaObjectToBuffer(mediaObject, ScryptedMimeTypes.RTCAVSignalingOfferSetup);
  const setup: RTCAVSignalingOfferSetup = JSON.parse(buffer.toString());
  return setup;
}

export async function startRTCPeerConnectionFFmpegInput(ffInput: FFMpegInput): Promise<RTCPeerConnection> {
  initalizeWebRtc();

  const pc = new RTCPeerConnection(configuration);

  const { RTCVideoSource, RTCAudioSource } = wrtc.nonstandard;

  const videoSource = new RTCVideoSource();
  pc.addTrack(videoSource.createTrack());


  let audioPort: number;

  // wrtc causes browser to hang if there's no audio track? so always make sure one exists.
  const noAudio = ffInput.mediaStreamOptions && ffInput.mediaStreamOptions.audio === null;

  let audioServer: net.Server;
  if (!noAudio) {
    const audioSource = new RTCAudioSource();
    pc.addTrack(audioSource.createTrack());

    audioServer = net.createServer(async (socket) => {
      audioServer.close()
      const { sample_rate, channels } = await sampleInfo;
      const bitsPerSample = 16;
      const channelCount = channels[1] === 'mono' ? 1 : 2;
      const sampleRate = parseInt(sample_rate[1]);

      const toRead = sampleRate / 100 * channelCount * 2;
      socket.on('readable', () => {
        while (true) {
          const buffer: Buffer = socket.read(toRead);
          if (!buffer)
            return;

          const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + toRead)
          const samples = new Int16Array(ab);  // 10 ms of 16-bit mono audio

          const data = {
            samples,
            sampleRate,
            bitsPerSample,
            channelCount,
          };
          try {
            audioSource.onData(data);
          }
          catch (e) {
            cp.kill();
            console.error(e);
          }
        }
      });
    });
    audioPort = await listenZero(audioServer);
  }

  const videoServer = net.createServer(async (socket) => {
    videoServer.close()
    const res = await resolution;
    const width = parseInt(res[2]);
    const height = parseInt(res[3]);
    const toRead = parseInt(res[2]) * parseInt(res[3]) * 1.5;
    socket.on('readable', () => {
      while (true) {
        const buffer: Buffer = socket.read(toRead);
        if (!buffer)
          return;
        const data = new Uint8ClampedArray(buffer);
        const frame = { width, height, data };
        try {
          videoSource.onFrame(frame)
        }
        catch (e) {
          cp.kill();
          console.error(e);
        }
      }
    });
  });
  const videoPort = await listenZero(videoServer);

  const args = [
    '-hide_banner',
    // don't think this is actually necessary but whatever.
    '-y',
  ];

  args.push(...ffInput.inputArguments);

  if (!noAudio) {
    // create a dummy audio track if none actually exists.
    // this track will only be used if no audio track is available.
    // https://stackoverflow.com/questions/37862432/ffmpeg-output-silent-audio-track-if-source-has-no-audio-or-audio-is-shorter-th
    args.push('-f', 'lavfi', '-i', 'anullsrc=cl=1', '-shortest');

    args.push('-vn');
    args.push('-acodec', 'pcm_s16le');
    args.push('-f', 's16le');
    args.push(`tcp://127.0.0.1:${audioPort}`);
  }

  args.push('-an');
  // chromecast seems to crap out on higher than 15fps??? is there
  // some webrtc video negotiation that is failing here?
  args.push('-r', '15');
  args.push('-vcodec', 'rawvideo');
  args.push('-pix_fmt', 'yuv420p');
  args.push('-f', 'rawvideo');
  args.push(`tcp://127.0.0.1:${videoPort}`);

  console.log(ffInput);
  console.log(args);

  const cp = child_process.spawn(await mediaManager.getFFmpegPath(), args, {
    // DO NOT IGNORE STDIO, NEED THE DATA FOR RESOLUTION PARSING, ETC.
  });
  ffmpegLogInitialOutput(console, cp);
  cp.on('error', e => console.error('ffmpeg error', e));

  cp.on('exit', () => {
    videoServer.close();
    audioServer?.close();
    pc.close();
  });

  const resolution = new Promise<Array<string>>(resolve => {
    cp.stdout.on('data', data => {
      const stdout = data.toString();
      const res = /(([0-9]{2,5})x([0-9]{2,5}))/.exec(stdout);
      if (res)
        resolve(res);
    });
    cp.stderr.on('data', data => {
      const stdout = data.toString();
      const res = /(([0-9]{2,5})x([0-9]{2,5}))/.exec(stdout);
      if (res)
        resolve(res);
    });
  });

  interface SampleInfo {
    sample_rate: string[];
    channels: string[];
  }

  const sampleInfo = new Promise<SampleInfo>(resolve => {
    const parser = (data: Buffer) => {
      const stdout = data.toString();
      const sample_rate = /([0-9]+) Hz/i.exec(stdout)
      const channels = /Audio:.* (stereo|mono)/.exec(stdout)
      if (sample_rate && channels) {
        resolve({
          sample_rate, channels,
        });
      }
    };
    cp.stdout.on('data', parser);
    cp.stderr.on('data', parser);
  });

  const cleanup = () => {
    cp?.kill();
    setTimeout(() => cp?.kill('SIGKILL'), 1000);
  }

  const checkConn = () => {
    if (pc.iceConnectionState === 'disconnected'
      || pc.iceConnectionState === 'failed'
      || pc.iceConnectionState === 'closed') {
      cleanup();
    }
    if (pc.connectionState === 'closed'
      || pc.connectionState === 'disconnected'
      || pc.connectionState === 'failed') {
      cleanup();
    }
  }

  pc.onconnectionstatechange = checkConn;
  pc.oniceconnectionstatechange = checkConn;

  setTimeout(() => {
    if (pc.connectionState !== 'connected') {
      pc.close();
      cp.kill();
    }
  }, 60000);
  return pc;
}

export async function startRTCPeerConnection(mediaObject: MediaObject, offer: RTCAVMessage): Promise<RTCPeerConnectionMediaObjectSession> {
  const configuration: RTCConfiguration = {
    iceServers: [
      {
        urls: ["turn:turn0.clockworkmod.com", "turn:n0.clockworkmod.com", "turn:n1.clockworkmod.com"],
        username: "foo",
        credential: "bar",
      },
    ],
  };

  const buffer = await mediaManager.convertMediaObjectToBuffer(mediaObject, ScryptedMimeTypes.FFmpegInput);
  const ffInput = JSON.parse(buffer.toString());

  const pc = await startRTCPeerConnectionFFmpegInput(ffInput);

  const done = new Promise(resolve => {
    pc.onicecandidate = ev => {
      if (!ev.candidate)
        resolve(undefined);
    }
  })
  await pc.setRemoteDescription(offer.description);
  for (const c of offer.candidates || []) {
    pc.addIceCandidate(c);
  }
  let answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await done;


  return {
    pc,
    answer: {
      id: undefined,
      candidates: undefined,
      description: pc.currentLocalDescription,
      configuration,
    }
  };
}
