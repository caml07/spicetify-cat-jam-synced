import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CatJamController, CatJamConfig, AnalysisResult } from "./controller";

const CONFIG: CatJamConfig = { videoUrl: "http://x/cat.webm", defaultBpm: 135.48 };

function fakeVideo() {
  return {
    playbackRate: 1,
    currentTime: 1,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    isConnected: true,
  } as any;
}

describe("CatJamController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeController(fetchAnalysis: (uri: string) => Promise<AnalysisResult | null>) {
    return new CatJamController({
      getConfig: () => CONFIG,
      fetchAnalysis,
      nowMs: () => Date.now(),
    });
  }

  it("stale analysis result cannot overwrite a newer track", async () => {
    const pendingA = deferred<AnalysisResult | null>();
    const c = makeController((uri) =>
      uri === "spotify:track:A" ? pendingA.promise : Promise.resolve({ tempoBpm: 270.96 })
    );
    const video = fakeVideo();
    c.setVideo(video);

    c.onSongChange("spotify:track:A");
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBeCloseTo(1);

    c.onSongChange("spotify:track:B");
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBeCloseTo(2); // 270.96 / 135.48

    pendingA.resolve({ tempoBpm: 60 }); // late result for the OLD track
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBeCloseTo(2); // unchanged by stale A
  });

  it("song change cancels pending beat timers of the previous track", async () => {
    const neverResolves = new Promise<AnalysisResult | null>(() => {});
    let track = "A";
    const c = makeController(() =>
      track === "A"
        ? Promise.resolve({ tempoBpm: 135.48, beats: [{ start: 10 }] })
        : neverResolves
    );
    const video = fakeVideo();
    c.setVideo(video);

    c.onSongChange("spotify:track:A");
    await vi.advanceTimersByTimeAsync(0); // A's beat timer armed ~10s out

    track = "B";
    c.onSongChange("spotify:track:B");
    await vi.advanceTimersByTimeAsync(0);
    const playsNow = video.play.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(video.play.mock.calls.length).toBe(playsNow); // A's stale timer never fired
  });

  it("pause clears pending timers and pauses video", async () => {
    const c = makeController(() =>
      Promise.resolve({ tempoBpm: 135.48, beats: [{ start: 5 }] })
    );
    const video = fakeVideo();
    c.setVideo(video);

    c.onSongChange("spotify:track:A");
    await vi.advanceTimersByTimeAsync(0);
    c.onPlayPause(false, 0);

    const plays = video.play.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(video.play.mock.calls.length).toBe(plays);
    expect(video.pause).toHaveBeenCalled();
  });

  it("resumes and resyncs on play", async () => {
    const c = makeController(() =>
      Promise.resolve({ tempoBpm: 135.48, beats: [{ start: 2 }] })
    );
    const video = fakeVideo();
    c.setVideo(video);
    c.onSongChange("spotify:track:A");
    await vi.advanceTimersByTimeAsync(0);

    c.onPlayPause(false, 0);
    c.onPlayPause(true, 0);
    vi.advanceTimersByTime(2_000);
    expect(video.currentTime).toBe(0); // beat timer fired after resume
  });

  it("coalesces progress events: normal ticks keep state, seeks resync once", async () => {
    const c = makeController(() =>
      Promise.resolve({ tempoBpm: 135.48, beats: [{ start: 30 }] })
    );
    const video = fakeVideo();
    c.setVideo(video);
    c.onSongChange("spotify:track:A");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1); // one pending beat timer

    c.onProgress(1_000);
    c.onProgress(1_250);
    c.onProgress(1_500);
    expect(vi.getTimerCount()).toBe(1); // ticks did not pile up timers

    c.onProgress(40_000); // seek past every known beat
    expect(vi.getTimerCount()).toBe(0); // stale beat timer dropped, none scheduled
  });

  it("falls back safely when analysis is unavailable", async () => {
    const c = makeController(() => Promise.resolve(null));
    const video = fakeVideo();
    c.setVideo(video);

    c.onSongChange("spotify:track:A");
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBeCloseTo(1);
    expect(video.play).toHaveBeenCalled(); // cat keeps dancing without analysis
  });

  it("safePlay swallows play() rejections", async () => {
    const c = makeController(() => Promise.resolve({ tempoBpm: 135.48 }));
    const video = fakeVideo();
    video.play.mockRejectedValue(new Error("NotAllowedError"));
    c.setVideo(video);

    c.onSongChange("spotify:track:A");
    await vi.advanceTimersByTimeAsync(0); // no unhandled rejection escapes
    expect(video.play).toHaveBeenCalled();
    expect(() => vi.getTimerCount()).not.toThrow();
  });

  it("no-ops safely without a mounted video", async () => {
    const c = makeController(() => Promise.resolve({ tempoBpm: 180 }));
    expect(() => {
      c.onSongChange("spotify:track:A");
      c.onPlayPause(true, 0);
      c.onProgress(0);
    }).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
