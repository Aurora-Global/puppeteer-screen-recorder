import { EventEmitter } from 'events';
import os from 'os';
import { extname } from 'path';
import { PassThrough, Writable } from 'stream';

import ffmpeg, { setFfmpegPath } from 'fluent-ffmpeg';

import {
  pageScreenFrame,
  SupportedFileFormats,
  VIDEO_WRITE_STATUS,
  VideoOptions,
} from './pageVideoStreamTypes';

const SUPPORTED_FILE_FORMATS = [
  SupportedFileFormats.MP4,
  SupportedFileFormats.AVI,
  SupportedFileFormats.MOV,
  SupportedFileFormats.WEBM,
];

export default class PageVideoStreamWriter extends EventEmitter {
  private readonly screenLimit = 10;
  private screenCastFrames = [];
  public duration = '00:00:00:00';
  public frameGain = 0;
  public frameLoss = 0;

  private status = VIDEO_WRITE_STATUS.NOT_STARTED;
  private options: VideoOptions;

  private videoMediatorStream: PassThrough = new PassThrough();
  private writerPromise: Promise<boolean>;
  private destinationExt: SupportedFileFormats | null = null;

  constructor(destinationSource: string | Writable, options?: VideoOptions) {
    super();

    if (options) {
      this.options = options;
    }

    const isWritable = this.isWritableStream(destinationSource);
    this.configureFFmPegPath();

    if (!isWritable && typeof destinationSource === 'string') {
      this.destinationExt = this.getDestinationPathExtension(destinationSource);
    }

    if (isWritable) {
      this.configureVideoWritableStream(destinationSource as Writable);
    } else {
      this.configureVideoFile(destinationSource as string);
    }
  }

  private get videoFrameSize(): string {
    const { width, height } = this.options.videoFrame;
    return width !== null && height !== null ? `${width}x${height}` : '100%';
  }

  private get autopad(): { activation: boolean; color?: string } {
    const autopad = this.options.autopad;
    return !autopad ? { activation: false } : { activation: true, color: autopad.color };
  }

  private getFfmpegPath(): string | null {
    if (this.options.ffmpeg_Path) return this.options.ffmpeg_Path;
    try {
      const ffmpeg = require('@ffmpeg-installer/ffmpeg');
      return ffmpeg.path || null;
    } catch {
      return null;
    }
  }

  private getDestinationPathExtension(destinationFile): SupportedFileFormats {
    const fileExtension = extname(destinationFile);
    return fileExtension.includes('.')
      ? (fileExtension.replace('.', '') as SupportedFileFormats)
      : (fileExtension as SupportedFileFormats);
  }

  private configureFFmPegPath(): void {
    const ffmpegPath = this.getFfmpegPath();
    if (!ffmpegPath) {
      throw new Error('FFmpeg path is missing, \n Set the FFMPEG_PATH env variable');
    }
    setFfmpegPath(ffmpegPath);
  }

  private isWritableStream(destinationSource: string | Writable): boolean {
    return destinationSource && typeof destinationSource !== 'string';
  }

  private configureVideoFile(destinationPath: string): void {
    const fileExt = this.destinationExt;

    if (!SUPPORTED_FILE_FORMATS.includes(fileExt)) {
      throw new Error('File format is not supported');
    }

    this.writerPromise = new Promise((resolve) => {
      const outputStream = this.getDestinationStream();

      outputStream
        .on('error', (e) => {
          this.handleWriteStreamError(e.message);
          resolve(false);
        })
        .on('stderr', (e) => {
          this.handleWriteStreamError(e);
          resolve(false);
        })
        .on('end', () => resolve(true));

      if (fileExt === SupportedFileFormats.WEBM) {
        outputStream
          .videoCodec('libvpx-vp9')
          .videoBitrate(this.options.videoBitrate || 1000, true)
          .format('webm')
          .outputOptions([
            '-deadline', 'realtime',
            '-cpu-used', '4',
            `-crf`, `${this.options.videoCrf ?? 32}`,
          ]);
      } else {
        outputStream.format(fileExt);
      }

      outputStream.save(destinationPath);
    });
  }

  private configureVideoWritableStream(writableStream: Writable) {
    const isWebm = this.options.videoCodec?.toLowerCase().includes('vp9') || false;

    this.writerPromise = new Promise((resolve) => {
      const outputStream = this.getDestinationStream();

      outputStream
        .on('error', (e) => {
          writableStream.emit('error', e);
          resolve(false);
        })
        .on('stderr', (e) => {
          writableStream.emit('error', { message: e });
          resolve(false);
        })
        .on('end', () => {
          writableStream.end();
          resolve(true);
        });

      if (isWebm) {
        outputStream
          .format('webm')
          .videoCodec('libvpx-vp9')
          .videoBitrate(this.options.videoBitrate || 1000, true)
          .outputOptions([
            '-deadline', 'realtime',
            '-cpu-used', '4',
            `-crf`, `${this.options.videoCrf ?? 32}`,
          ]);
      } else {
        outputStream
          .format('mp4')
          .addOutputOptions('-movflags +frag_keyframe+separate_moof+omit_tfhd_offset+empty_moov');
      }

      outputStream.pipe(writableStream);
    });
  }

  private getOutputOption() {
    const cpu = Math.max(1, os.cpus().length - 1);
    const videoOutputOptions = this.options.videOutputOptions ?? [];

    const outputOptions = [
      `-crf ${this.options.videoCrf ?? 23}`,
      `-preset ${this.options.videoPreset || 'ultrafast'}`,
      `-pix_fmt ${this.options.videoPixelFormat || 'yuv420p'}`,
      `-minrate ${this.options.videoBitrate || 1000}`,
      `-maxrate ${this.options.videoBitrate || 1000}`,
      '-framerate 1',
      `-threads ${cpu}`,
      '-loglevel error',
      ...videoOutputOptions,
    ];

    return outputOptions;
  }

  private addVideoMetadata(outputStream: ReturnType<typeof ffmpeg>) {
    const metadataOptions = this.options.metadata ?? [];
    for (const metadata of metadataOptions) {
      outputStream.outputOptions('-metadata', metadata);
    }
  }

  private getDestinationStream(): ffmpeg {
    const outputStream = ffmpeg({
      source: this.videoMediatorStream,
      priority: 20,
    })
      .videoCodec(this.options.videoCodec || 'libx264')
      .size(this.videoFrameSize)
      .aspect(this.options.aspectRatio || '4:3')
      .autopad(this.autopad.activation, this.autopad?.color)
      .inputFormat('image2pipe')
      .inputFPS(this.options.fps)
      .outputOptions(this.getOutputOption())
      .on('progress', (progressDetails) => {
        this.duration = progressDetails.timemark;
      });

    this.addVideoMetadata(outputStream);

    if (this.options.recordDurationLimit) {
      outputStream.duration(this.options.recordDurationLimit);
    }

    return outputStream;
  }

  private handleWriteStreamError(errorMessage): void {
    this.emit('videoStreamWriterError', errorMessage);
    if (
      this.status !== VIDEO_WRITE_STATUS.IN_PROGRESS &&
      errorMessage.includes('pipe:0: End of file')
    ) return;
    console.error(`Error unable to capture video stream: ${errorMessage}`);
  }

  private findSlot(timestamp: number): number {
    if (this.screenCastFrames.length === 0) return 0;

    let i: number;
    let frame: pageScreenFrame;

    for (i = this.screenCastFrames.length - 1; i >= 0; i--) {
      frame = this.screenCastFrames[i];
      if (timestamp > frame.timestamp) break;
    }

    return i + 1;
  }

  public insert(frame: pageScreenFrame): void {
    if (this.screenCastFrames.length === this.screenLimit) {
      const numberOfFramesToSplice = Math.floor(this.screenLimit / 2);
      const framesToProcess = this.screenCastFrames.splice(0, numberOfFramesToSplice);
      this.processFrameBeforeWrite(framesToProcess, this.screenCastFrames[0].timestamp);
    }

    const insertionIndex = this.findSlot(frame.timestamp);
    if (insertionIndex === this.screenCastFrames.length) {
      this.screenCastFrames.push(frame);
    } else {
      this.screenCastFrames.splice(insertionIndex, 0, frame);
    }
  }

  private trimFrame(fameList: pageScreenFrame[], chunkEndTime: number): pageScreenFrame[] {
    return fameList.map((currentFrame, index) => {
      const endTime = index !== fameList.length - 1 ? fameList[index + 1].timestamp : chunkEndTime;
      return { ...currentFrame, duration: endTime - currentFrame.timestamp };
    });
  }

  private processFrameBeforeWrite(frames: pageScreenFrame[], chunkEndTime: number): void {
    const processedFrames = this.trimFrame(frames, chunkEndTime);
    processedFrames.forEach(({ blob, duration }) => {
      this.write(blob, duration);
    });
  }

  public write(data: Buffer, durationSeconds = 1): void {
    this.status = VIDEO_WRITE_STATUS.IN_PROGRESS;
    const totalFrames = durationSeconds * this.options.fps;
    const floored = Math.floor(totalFrames);

    let numberOfFPS = Math.max(floored, 1);
    if (floored === 0) this.frameGain += 1 - totalFrames;
    else this.frameLoss += totalFrames - floored;

    while (this.frameLoss > 1) {
      this.frameLoss--;
      numberOfFPS++;
    }
    while (this.frameGain > 1) {
      this.frameGain--;
      numberOfFPS--;
    }

    for (let i = 0; i < numberOfFPS; i++) {
      this.videoMediatorStream.write(data);
    }
  }

  private drainFrames(stoppedTime: number): void {
    this.processFrameBeforeWrite(this.screenCastFrames, stoppedTime);
    this.screenCastFrames = [];
  }

  public stop(stoppedTime = Date.now() / 1000): Promise<boolean> {
    if (this.status === VIDEO_WRITE_STATUS.COMPLETED) return this.writerPromise;

    this.drainFrames(stoppedTime);
    this.videoMediatorStream.end();
    this.status = VIDEO_WRITE_STATUS.COMPLETED;
    return this.writerPromise;
  }
}
