export declare const SETTINGS_NAMESPACE = "effort-auto-toggle";
export interface Config {
    enabled: boolean;
    autoOn: boolean;
    mode: "minimax" | "heuristic";
    minimaxApiKey: string;
    minimaxBaseUrl: string;
    minimaxModel: string;
    scoreTimeoutMs: number;
    allowToolUpgrade: boolean;
    clampForcedThinkingOff: boolean;
    ledgerDir: string;
}
export declare const Config: any;
export declare const DEFAULT_CONFIG: Config;
export declare function apply(ctx: any, config?: Partial<Config>): void;
export declare function reportFor(sessionId: string, dir?: string): Promise<string>;
