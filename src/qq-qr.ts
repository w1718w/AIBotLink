import { randomBytes } from 'node:crypto';
import { startQrConnect, type QrConnectCallbacks, type QrConnectCredentials } from '@tencent-connect/qqbot-connector';
import { toDataURL } from 'qrcode';
import { Bot, ReceiverMode } from 'qq-official-bot';
import { dataHome, type Config } from './config.js';
import { t, type MessageKey } from './messages.js';

export interface QqQrPublicState {
  status: 'idle' | 'connecting' | 'qr' | 'select' | 'pairing' | 'saving' | 'ready' | 'cancelled' | 'expired' | 'error';
  busy: boolean; messageKey?: MessageKey; qrDataUrl?: string; pairingCode?: string; candidates?: { appId: string }[];
}
export interface PairingReceiver {
  on(event: string, listener: (event: any) => void): unknown;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
}
export interface QqQrSetupOptions {
  load(): Promise<Config | undefined>;
  save(config: Config): Promise<void>;
  defaults(): Config;
  isRunning(): boolean;
  // Dependency injection keeps acceptance tests offline; production uses only
  // the connector's public API and locally generated QR images.
  qrFactory?: typeof startQrConnect;
  makeQrDataUrl?: (url: string) => Promise<string>;
  createPairReceiver?: (credential: QrConnectCredentials) => PairingReceiver;
  qrTimeoutMs?: number;
  pairTimeoutMs?: number;
}

export class QqQrSetup {
  private state: Omit<QqQrPublicState, 'busy'> = { status: 'idle' };
  private generation = 0;
  private controller?: AbortController;
  private disposeQr?: () => void;
  private receiver?: PairingReceiver;
  private timer?: NodeJS.Timeout;
  private candidates: QrConnectCredentials[] = [];
  private accepted = false;
  private work = Promise.resolve();
  constructor(private readonly options: QqQrSetupOptions) {}
  status(): QqQrPublicState {
    return structuredClone({ ...this.state, busy: Boolean(this.receiver) || ['connecting', 'qr', 'select', 'pairing', 'saving'].includes(this.state.status) });
  }
  private current(generation: number) { return generation === this.generation; }
  private schedule(task: () => Promise<void>) {
    const next = this.work.catch(() => {}).then(task); this.work = next.catch(() => {}); return next;
  }
  private timeout(generation: number, milliseconds: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.current(generation)) return;
      ++this.generation; this.state = { status: 'expired', messageKey: 'qqQr.expired' };
      this.candidates = []; this.accepted = true;
      void this.schedule(() => this.cleanup()).catch(() => { this.state = { status: 'error', messageKey: 'qqQr.stopFailed' }; });
    }, milliseconds);
    this.timer.unref();
  }
  private async cleanup() {
    clearTimeout(this.timer); this.timer = undefined;
    this.stopQr();
    const receiver = this.receiver;
    if (receiver) { await receiver.stop(); if (this.receiver === receiver) this.receiver = undefined; }
  }
  private stopQr() {
    this.controller?.abort(); this.controller = undefined;
    const dispose = this.disposeQr; this.disposeQr = undefined;
    try { dispose?.(); } catch { /* The AbortSignal also stops SDK polling. */ }
  }
  async start(): Promise<QqQrPublicState> {
    if (this.options.isRunning()) throw new Error(t('qqQr.gatewayRunning'));
    // Invalidate callbacks synchronously before waiting for any prior work.
    const generation = ++this.generation;
    this.accepted = true; this.candidates = [];
    await this.schedule(() => this.cleanup());
    if (!this.current(generation)) return this.status();
    if (this.options.isRunning()) throw new Error(t('qqQr.gatewayRunning'));
    this.state = { status: 'connecting', messageKey: 'qqQr.connecting' }; this.accepted = false;
    const controller = new AbortController(); this.controller = controller;
    this.timeout(generation, this.options.qrTimeoutMs ?? 5 * 60_000);
    const callbacks: QrConnectCallbacks = {
      onQrDisplayed: url => {
        if (!this.current(generation) || this.accepted) return;
        // The authorization URL is encoded locally, never sent to an image API.
        void (this.options.makeQrDataUrl ?? (value => toDataURL(value, { errorCorrectionLevel: 'M', margin: 2 })))(url).then(qrDataUrl => {
          if (this.current(generation) && !this.accepted) this.state = { status: 'qr', qrDataUrl, messageKey: 'qqQr.scan' };
        }).catch(() => this.fail(generation));
      },
      onQrExpired: () => { if (this.current(generation) && !this.accepted) this.state = { status: 'connecting', messageKey: 'qqQr.refreshing' }; },
      onSuccess: credentials => {
        if (!this.current(generation) || this.accepted) return;
        this.accepted = true;
        this.stopQr();
        this.candidates = Array.isArray(credentials) ? credentials.filter(c => c && typeof c.appId === 'string' && c.appId && typeof c.appSecret === 'string' && c.appSecret).map(c => ({ appId: c.appId, appSecret: c.appSecret, ...(typeof c.userOpenid === 'string' && c.userOpenid ? { userOpenid: c.userOpenid } : {}) })) : [];
        if (!this.candidates.length || new Set(this.candidates.map(c => c.appId)).size !== this.candidates.length) { this.fail(generation); return; }
        if (this.candidates.length > 1) this.state = { status: 'select', candidates: this.candidates.map(c => ({ appId: c.appId })), messageKey: 'qqQr.select' };
        else void this.select(this.candidates[0].appId).catch(() => this.fail(generation));
      },
      onFailure: () => { if (!this.accepted) this.fail(generation); },
    };
    try {
      const dispose = (this.options.qrFactory ?? startQrConnect)(callbacks, { displayQrCodeToConsole: false, source: 'aibotlink', signal: controller.signal });
      if (!this.current(generation) || this.accepted) dispose();
      else this.disposeQr = dispose;
    } catch { this.fail(generation); }
    return this.status();
  }
  private fail(generation: number) {
    if (!this.current(generation)) return;
    ++this.generation; this.accepted = true; this.candidates = [];
    this.state = { status: 'error', messageKey: 'qqQr.failed' };
    void this.schedule(() => this.cleanup()).catch(() => { this.state = { status: 'error', messageKey: 'qqQr.stopFailed' }; });
  }
  async select(appId: string): Promise<void> {
    const generation = this.generation;
    const credential = this.candidates.find(c => c.appId === appId);
    if (!credential || !['select', 'connecting', 'qr'].includes(this.state.status)) throw new Error(t('qqQr.invalidSelection'));
    this.candidates = []; this.state = { status: 'connecting', messageKey: 'qqQr.connecting' };
    await this.schedule(async () => {
      await this.cleanup(); if (!this.current(generation)) return;
      if (this.options.isRunning()) throw new Error(t('qqQr.gatewayRunning'));
      if (credential.userOpenid) { await this.persist(generation, credential, credential.userOpenid); return; }
      this.beginPairing(generation, credential);
    }).catch(() => this.fail(generation));
  }
  private beginPairing(generation: number, credential: QrConnectCredentials) {
    if (!this.current(generation)) return;
    const pairingCode = randomBytes(6).toString('base64url');
    const receiver = this.options.createPairReceiver?.(credential) ?? new Bot({ appid: credential.appId, secret: credential.appSecret,
      mode: ReceiverMode.WEBSOCKET, intents: ['GROUP_AND_C2C_EVENT'], logLevel: 'off', dataDir: dataHome, handleProcessErrors: false });
    this.receiver = receiver;
    this.state = { status: 'pairing', pairingCode, messageKey: 'qqQr.pair' };
    this.timeout(generation, this.options.pairTimeoutMs ?? 3 * 60_000);
    const receiverFailed = () => {
      // Intentional shutdown can reject a still-pending WebSocket startup.
      // It must not overwrite a completed save or a cancellation with failure.
      if (this.receiver === receiver && this.state.status === 'pairing') this.fail(generation);
    };
    receiver.on('error', receiverFailed);
    receiver.on('message.private.friend', event => {
      if (!this.current(generation) || this.state.status !== 'pairing' || this.receiver !== receiver ||
        typeof event.user_id !== 'string' || !event.user_id || event.raw_message?.trim() !== `/pair ${pairingCode}`) return;
      // Consume before asynchronous cleanup/save. Nothing from this temporary
      // receiver is ever forwarded to an Agent or answered with bot messages.
      this.state = { status: 'saving', messageKey: 'qqQr.saving' };
      void this.schedule(() => this.persist(generation, credential, event.user_id)).catch(() => this.fail(generation));
    });
    void receiver.start().then(async () => {
      if (!this.current(generation) || this.receiver !== receiver) await receiver.stop();
    }).catch(receiverFailed);
  }
  private async persist(generation: number, credential: QrConnectCredentials, owner: string) {
    if (!this.current(generation)) return;
    this.state = { status: 'saving', messageKey: 'qqQr.saving' };
    await this.cleanup(); if (!this.current(generation)) return;
    const previous = await this.options.load(); if (!this.current(generation)) return;
    if (this.options.isRunning()) throw new Error(t('qqQr.gatewayRunning'));
    const config = structuredClone(previous ?? this.options.defaults());
    const sameBot = previous?.qq.appid === credential.appId;
    config.qq = { appid: credential.appId, secret: credential.appSecret,
      allowedUsers: [...new Set([...(sameBot ? previous!.qq.allowedUsers : []), owner])],
      allowedGroups: sameBot ? previous!.qq.allowedGroups : [] };
    await this.options.save(config);
    if (this.current(generation)) this.state = { status: 'ready', messageKey: 'qqQr.ready' };
  }
  async cancel(): Promise<void> {
    ++this.generation; this.accepted = true; this.candidates = [];
    this.state = { status: 'cancelled', messageKey: 'qqQr.cancelled' };
    try { await this.schedule(() => this.cleanup()); }
    catch { this.state = { status: 'error', messageKey: 'qqQr.stopFailed' }; }
  }
}
