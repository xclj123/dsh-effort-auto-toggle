window.__ModuleLoader__.load({
	id: "dsh-effort-auto-toggle",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region locales.ts
		const NS = "effort-auto-toggle";
		const zh = {
			"card.title": "自动思考档位（按钮开关）",
			"card.description": "输入栏模型选择器旁有一枚「自动」按钮：点亮 = 按消息复杂度自动调度 low/high/max；再点熄灭 = 回到人工选择的推理等级。此处仅配置打分后端与开关。",
			"card.enabled": "启用插件",
			"card.autoOn": "自动调度（与输入栏按钮联动）",
			"card.mode": "打分后端",
			"card.model": "打分模型",
			"card.apiKey": "API Key",
			"card.apiKeyPlaceholder": "留空则读环境变量 MINIMAX_API_KEY",
			"card.mode.minimax": "MiniMax（LLM 判分，需 API Key）",
			"card.mode.heuristic": "启发式（零依赖，离线可用）",
			"card.allowToolUpgrade": "允许重负载工具把档位升到最高",
			"card.unavailable": "设置命名空间不可用：请确认 dsh-effort-auto-toggle 已装配进 profile。",
			"card.readonly": "只读",
			"btn.auto": "自动",
			"btn.onHint": "自动调度已开启：按消息复杂度在 low/high/max 之间自动选择推理等级。点击关闭，回到人工选择。",
			"btn.offHint": "自动调度已关闭：使用模型弹窗里人工选择的推理等级。点击开启自动调度。",
			"btn.unavailable": "设置命名空间不可用，无法切换",
			"label.model": "模型",
			"label.effort": "思考",
			"label.tokens": "输出",
			"label.clickHint": "点击回到这条回复的开头",
			"effort.unknown": "auto"
		};
		const en = {
			"card.title": "Auto Effort (button toggle)",
			"card.description": "An Auto button sits next to the model selector in the composer: lit = schedule low/high/max by message complexity; click again to dim it and return to manual effort picking. This card only configures the scorer backend.",
			"card.enabled": "Enable plugin",
			"card.autoOn": "Auto scheduling (linked with the composer button)",
			"card.mode": "Scorer backend",
			"card.model": "Scorer model",
			"card.apiKey": "API Key",
			"card.apiKeyPlaceholder": "Empty falls back to env MINIMAX_API_KEY",
			"card.mode.minimax": "MiniMax (LLM judge, needs API key)",
			"card.mode.heuristic": "Heuristic (zero-dependency, offline)",
			"card.allowToolUpgrade": "Allow heavy tool payloads to upgrade to Max",
			"card.unavailable": "Settings namespace unavailable: make sure dsh-effort-auto-toggle is assembled into this profile.",
			"card.readonly": "Read-only",
			"btn.auto": "Auto",
			"btn.onHint": "Auto scheduling ON: reasoning effort is picked per message between low/high/max. Click to turn off and go back to manual.",
			"btn.offHint": "Auto scheduling OFF: the manual effort picker rules. Click to enable auto scheduling.",
			"btn.unavailable": "Settings namespace unavailable, cannot toggle",
			"label.model": "Model",
			"label.effort": "Effort",
			"label.tokens": "Output",
			"label.clickHint": "Click to jump back to the start of this reply",
			"effort.unknown": "auto"
		};
		//#endregion
		//#region settings-scope (0.2.x configForms)
		// The settings service keys forms by profile entry id (= package name).
		// Resolve at every render: the service may appear after apply(), and the
		// browser boot may prefix entry ids (take the part after the last colon).
		const PKG_SCOPE_NS = "dsh-effort-auto-toggle";
		function scopeCandidates(ctx) {
			const list = [];
			try {
				const fiber = ctx && ctx.fiber;
				const entry = fiber ? fiber.entry : null;
				const raw = entry ? (entry.options && entry.options.id) || entry.id : null;
				if (typeof raw === "string" && raw !== "") {
					const colon = raw.lastIndexOf(String.fromCharCode(58));
					list.push(colon === -1 ? raw : raw.slice(colon + 1));
				}
			} catch {}
			list.push(PKG_SCOPE_NS);
			return list;
		}
		function resolveScope(ctx) {
			try {
				const forms = ctx && ctx.configForms;
				if (!forms || typeof forms.get !== "function") return null;
				const candidates = scopeCandidates(ctx);
				let ns = candidates[candidates.length - 1];
				try {
					const mirror = typeof forms.describe === "function" ? forms.describe() : null;
					const snap = mirror && typeof mirror.getSnapshot === "function" ? mirror.getSnapshot() : null;
					const view = snap && snap.view;
					const served = view && Array.isArray(view.namespaces) ? view.namespaces : null;
					if (served) {
						for (const cand of candidates) {
							if (served.some((row) => row && row.ns === cand)) { ns = cand; break; }
						}
					}
				} catch {}
				const scope = forms.get(ns);
				return scope && typeof scope.getSnapshot === "function" ? scope : null;
			} catch {
				return null;
			}
		}
		function scopeSet(scope, key, value) {
			try {
				const pending = scope && scope.set(key, value);
				if (pending && typeof pending.catch === "function") pending.catch(() => {});
			} catch {}
		}
		function scopeClear(scope, key) {
			try {
				if (scope && typeof scope.unset === "function") { scope.unset(key); return; }
				scopeSet(scope, key, "");
			} catch {}
		}
		//#endregion
		//#region model-selection face (0.1.6)
		// `conversation.input.right` is a scope:"session" slot, so the occupant's
		// inject callback receives the sessionId. The client sessions service
		// exposes per-session projections; the host `modelSelection` unit folds
		// request/header events, so its wire view's `lastUsed` IS the effort the
		// latest request actually ran with (override included). Subscribing that
		// face gives the button a live "what tier is running right now" read.
		// 0.2.0: effort levels are model-specific ("low", "highx", "ultra", ...)
		// and already English wire ids — display them verbatim, no mapping.
		let sessionsRef = null;
		function modelFace(ctx, sessionId) {
			try {
				const sessions = sessionsRef
					|| (ctx && typeof ctx.get === "function" ? ctx.get("sessions") : null)
					|| (ctx && ctx.sessions)
					|| null;
				if (!sessions || typeof sessions.binding !== "function") return null;
				if (typeof sessionId !== "string" || sessionId === "") return null;
				const binding = sessions.binding(sessionId);
				const projections = binding && binding.session && binding.session.projections;
				const face = projections && typeof projections.faceOf === "function" ? projections.faceOf("modelSelection") : null;
				return face && typeof face.subscribe === "function" && typeof face.getSnapshot === "function" ? face : null;
			} catch {
				return null;
			}
		}
		function lastUsedEffortLabel(sel) {
			const effort = sel && sel.lastUsed && typeof sel.lastUsed.reasoningEffort === "string" ? sel.lastUsed.reasoningEffort : null;
			return effort && effort.length > 0 ? effort : null;
		}
		//#endregion

		//#region AutoToggleButton.tsx
		/**
		* The composer auto toggle — the plugin's effort entry point.
		* Lit (cyan pill + glow): scheduling ON, complexity scoring picks
		* low/high/max per message. Dim: manual effort picking rules again.
		* State lives in the settings namespace `effort-auto-toggle` key
		* `autoOn`, so the host half sees the flip on the next request.
		*/
		function AutoToggleButton({ t, scope, sessionId, ctx }) {
			const safeScope = scope && typeof scope.subscribe === "function" && typeof scope.getSnapshot === "function" ? scope : null;
			let snapshot;
			try {
				snapshot = (0, react.useSyncExternalStore)((listener) => (safeScope ? safeScope.subscribe(listener) : () => {}), () => (safeScope ? safeScope.getSnapshot() : void 0));
			} catch {
				snapshot = void 0;
			}
			const face = modelFace(ctx, sessionId);
			let sel;
			try {
				sel = (0, react.useSyncExternalStore)((listener) => (face ? face.subscribe(listener) : () => {}), () => (face ? face.getSnapshot() : void 0));
			} catch {
				sel = void 0;
			}
			const unavailable = !safeScope || !snapshot || snapshot.status !== "ready";
			const readonly = unavailable || snapshot.writable === false;
			const value = (snapshot && snapshot.value) || {};
			const autoOn = value.autoOn === true;
			const tierLabel = lastUsedEffortLabel(sel);
			const buttonLabel = autoOn && tierLabel ? t("btn.auto") + "·" + tierLabel : t("btn.auto");
			const toggle = () => {
				if (readonly || !safeScope) return;
				scopeSet(safeScope, "autoOn", !autoOn);
			};
			const base = {
				display: "inline-flex",
				alignItems: "center",
				gap: "4px",
				height: "24px",
				padding: "0 10px",
				fontSize: "12px",
				lineHeight: "22px",
				borderRadius: "999px",
				cursor: readonly ? "not-allowed" : "pointer",
				userSelect: "none",
				whiteSpace: "nowrap",
				transition: "background .15s ease, color .15s ease, box-shadow .15s ease, border-color .15s ease",
				fontWeight: autoOn ? 600 : 400
			};
			const style = autoOn
				? { ...base,
					background: "linear-gradient(135deg, #22d3ee 0%, #0ea5e9 100%)",
					color: "#05242b",
					border: "1px solid rgba(34,211,238,.9)",
					boxShadow: "0 0 0 1px rgba(34,211,238,.35), 0 0 10px rgba(34,211,238,.45)" }
				: { ...base,
					background: "transparent",
					color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,.9))",
					border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))",
					boxShadow: "none" };
			const title = unavailable ? t("btn.unavailable") : autoOn ? t("btn.onHint") : t("btn.offHint");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				style,
				title,
				"aria-label": "effort-auto-toggle-button",
				"aria-pressed": autoOn ? "true" : "false",
				disabled: readonly,
				onClick: toggle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { fontSize: "11px", lineHeight: 1 },
						children: autoOn ? "\u26A1" : "\u25CE"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: buttonLabel })
				]
			});
		}
		//#endregion
		//#region card.tsx
		const MODE_OPTIONS = ["minimax", "heuristic"];
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: "12px",
			padding: "6px 0",
			fontSize: "13px",
			lineHeight: "20px"
		};
		const labelStyle = { margin: 0, color: "var(--dsw-alias-label-primary)" };
		const controlStyle = {
			background: "var(--dsw-alias-bg-field, rgba(128, 128, 128, 0.12))",
			color: "var(--dsw-alias-label-primary, inherit)",
			border: "1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4))",
			borderRadius: "4px",
			padding: "3px 8px",
			fontSize: "13px"
		};
		function ToggleRow(props) {
			const { id, label, checked, disabled, onChange } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: rowStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
					htmlFor: id,
					style: labelStyle,
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					id,
					type: "checkbox",
					checked,
					disabled,
					onChange: (event) => onChange(event.currentTarget.checked)
				})]
			});
		}
		function AutoToggleCard({ t, scope }) {
			const safeScope = scope && typeof scope.subscribe === "function" && typeof scope.getSnapshot === "function" ? scope : null;
			let snapshot;
			try {
				snapshot = (0, react.useSyncExternalStore)((listener) => (safeScope ? safeScope.subscribe(listener) : () => {}), () => (safeScope ? safeScope.getSnapshot() : void 0));
			} catch {
				snapshot = void 0;
			}
			const unavailable = !safeScope || !snapshot || snapshot.status !== "ready";
			const readonly = unavailable || snapshot.writable === false;
			const value = (snapshot && snapshot.value) || {};
			const mode = MODE_OPTIONS.includes(value.mode) ? value.mode : "minimax";
			if (unavailable) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { padding: "12px 16px", fontSize: "13px", color: "var(--dsw-alias-label-tertiary)" },
				children: t("card.unavailable")
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: { padding: "12px 16px" },
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
						id: "plugin-config-effort-auto-toggle-autoon",
						label: t("card.autoOn"),
						checked: value.autoOn === true,
						disabled: readonly,
						onChange: (next) => { scopeSet(scope, "autoOn", next); }
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							htmlFor: "plugin-config-effort-auto-toggle-mode",
							style: labelStyle,
							children: t("card.mode")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
							id: "plugin-config-effort-auto-toggle-mode",
							"aria-label": "effort-auto-toggle-mode",
							value: mode,
							disabled: readonly,
							style: controlStyle,
							onChange: (event) => { scopeSet(scope, "mode", event.currentTarget.value); },
							children: MODE_OPTIONS.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", { value: option, children: t(`card.mode.${option}`) }, option))
						})]
					}),
					mode === "minimax" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							htmlFor: "plugin-config-effort-auto-toggle-key",
							style: labelStyle,
							children: t("card.apiKey")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							id: "plugin-config-effort-auto-toggle-key",
							"aria-label": "effort-auto-toggle-api-key",
							type: "password",
							autoComplete: "off",
							value: typeof value.minimaxApiKey === "string" ? value.minimaxApiKey : "",
							disabled: readonly,
							placeholder: t("card.apiKeyPlaceholder"),
							style: { ...controlStyle, width: "160px" },
							onChange: (event) => { scopeSet(scope, "minimaxApiKey", event.currentTarget.value); },
							onBlur: (event) => {
								if (event.currentTarget.value.trim().length === 0) scopeClear(scope, "minimaxApiKey");
							}
						})]
					}),
					mode === "minimax" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							htmlFor: "plugin-config-effort-auto-toggle-model",
							style: labelStyle,
							children: t("card.model")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							id: "plugin-config-effort-auto-toggle-model",
							"aria-label": "effort-auto-toggle-model",
							type: "text",
							value: typeof value.minimaxModel === "string" ? value.minimaxModel : "MiniMax-M3",
							disabled: readonly,
							placeholder: "MiniMax-M3",
							style: { ...controlStyle, width: "160px" },
							onChange: (event) => { scopeSet(scope, "minimaxModel", event.currentTarget.value); },
							onBlur: (event) => {
								if (event.currentTarget.value.trim().length === 0) scopeClear(scope, "minimaxModel");
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
						id: "plugin-config-effort-auto-toggle-enabled",
						label: t("card.enabled"),
						checked: value.enabled ?? true,
						disabled: readonly,
						onChange: (next) => { scopeSet(scope, "enabled", next); }
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
						id: "plugin-config-effort-auto-toggle-upgrade",
						label: t("card.allowToolUpgrade"),
						checked: value.allowToolUpgrade ?? true,
						disabled: readonly,
						onChange: (next) => { scopeSet(scope, "allowToolUpgrade", next); }
					}),
					snapshot && !snapshot.writable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: { margin: "8px 0 0", fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" },
						children: t("card.readonly")
					})
				]
			});
		}
		//#endregion
		//#region MessageBadge.tsx
		function isAssistantNode(node) {
			if (typeof node !== "object" || node === null) return false;
			return node.kind === "assistant";
		}
		function trajectoryRequestsOf(snapshot) {
			const requests = (snapshot.views?.get?.("trajectory"))?.requests;
			return Array.isArray(requests) ? requests : [];
		}
		function readMeta(node, requests) {
			if (node === void 0) return { model: void 0, effort: void 0, outputTokens: void 0 };
			const usage = typeof node.usage === "object" && node.usage !== null ? node.usage.outputTokens : void 0;
			const request = requests.find((candidate) => candidate.purpose === "assistant" && candidate.turn === node.turn && candidate.step === node.step);
			return {
				model: request?.requestConfig?.model ?? node.requestConfig?.model ?? node.provenance?.model,
				effort: request?.requestConfig?.reasoningEffort ?? node.requestConfig?.reasoningEffort,
				outputTokens: typeof usage === "number" && Number.isFinite(usage) && usage > 0 ? usage : void 0
			};
		}
		function findAssistantByMessageId(snapshot, messageId) {
			return (Array.isArray(snapshot.nodes) ? snapshot.nodes : []).filter(isAssistantNode).find((node) => node.messageId === messageId);
		}
		function readMetaTrajectory(snap, messageId) {
			const nodes = snap && Array.isArray(snap.eventNodes) ? snap.eventNodes : [];
			const node = nodes.filter((n) => n && n.kind === "assistant").find((n) => n.messageId === messageId);
			if (node === void 0) return { model: void 0, effort: void 0, outputTokens: void 0 };
			const turn = typeof node.turn === "number" ? node.turn : void 0;
			const requests = snap && Array.isArray(snap.requests) ? snap.requests : [];
			const request = turn === void 0 ? void 0 : requests.filter((c) => c && c.purpose === "assistant" && c.turn === turn).pop();
			const u = node.usage != null && typeof node.usage === "object" ? node.usage : request && request.usage != null && typeof request.usage === "object" ? request.usage : {};
			const output = typeof u.output === "number" ? u.output : typeof u.outputTokens === "number" ? u.outputTokens : void 0;
			const cfg = node.requestConfig != null && typeof node.requestConfig === "object" ? node.requestConfig : request && request.requestConfig != null && typeof request.requestConfig === "object" ? request.requestConfig : {};
			return {
				model: node.providerMetadata && node.providerMetadata.model || request && request.providerMetadata && request.providerMetadata.model || cfg.model,
				effort: cfg.reasoningEffort || cfg.effort,
				outputTokens: typeof output === "number" && Number.isFinite(output) && output > 0 ? output : void 0
			};
		}
		function formatTokens(tokens) {
			if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
			if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}k`;
			return String(tokens);
		}
		const badgeStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: "5px",
			padding: "1px 8px",
			fontSize: "11px",
			lineHeight: "17px",
			borderRadius: "999px",
			border: "1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4))",
			background: "var(--dsw-alias-bg-field, rgba(128, 128, 128, 0.12))",
			color: "var(--dsw-alias-label-secondary, inherit)",
			cursor: "pointer",
			userSelect: "none",
			whiteSpace: "nowrap",
			maxWidth: "100%",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};
		const separatorStyle = { opacity: .5 };
		function enclosingMessage(element) {
			return element.closest("[data-chat-flow-kind]");
		}
		function MessageBadge({ t, messageId, useSession, useTrajectory }) {
			let tMeta;
			try { tMeta = typeof useTrajectory === "function" ? useTrajectory((snapshot) => readMetaTrajectory(snapshot, messageId)) : void 0; } catch { tMeta = void 0; }
			let sMeta;
			try { sMeta = typeof useSession === "function" ? useSession((snapshot) => readMeta(findAssistantByMessageId(snapshot, messageId), trajectoryRequestsOf(snapshot))) : void 0; } catch { sMeta = void 0; }
			const meta = tMeta !== void 0 && (tMeta.model !== void 0 || tMeta.outputTokens !== void 0) ? tMeta : sMeta;
			if (meta === void 0 || meta.model === void 0 && meta.outputTokens === void 0) return null;
			const effortLabel = typeof meta.effort === "string" && meta.effort !== "" ? meta.effort : null;
			const jump = (event) => {
				enclosingMessage(event.currentTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				style: badgeStyle,
				title: t("label.clickHint"),
				"aria-label": "effort-auto-toggle-message-badge",
				onClick: jump,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: meta.model ?? "\u2014" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: separatorStyle, children: "\u00B7" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: effortLabel ?? t("effort.unknown") }),
					meta.outputTokens !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: separatorStyle, children: "\u00B7" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [formatTokens(meta.outputTokens), " tok"] })
					] })
				]
			});
		}
		//#endregion
		//#region index.ts
		const inject = ["slots", "locale", "configForms"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-effort-auto-toggle: dictionaries");
			// 0.1.7: cordis client services are not plain ctx properties unless
			// declared; grab the sessions service through a nested inject (the
			// model-selection precedent) and keep a live reference for the button.
			try {
				ctx.inject(["sessions"], (scope) => {
					sessionsRef = scope && scope.sessions && typeof scope.sessions.binding === "function" ? scope.sessions : null;
				});
			} catch { /* no sessions service here: the button falls back to the plain label */ }
			// The composer toggle. `conversation.input.model` is a kind:"single"
			// seat owned by the native model selector — injecting there evicts it.
			// `conversation.input.right` is a kind:"list" slot rendered to the LEFT
			// of the model seat, which is exactly the red-circled spot.
			ctx.slots.inject("conversation.input.right", function* () {
				yield ctx.slots.register({
					name: "conversation.input.right",
					id: "effort-auto-toggle-button",
					order: 10,
					locale: NS,
					inject: (sessionId) => ({ scope: resolveScope(ctx), sessionId, ctx })
				}, AutoToggleButton);
			});
			ctx.slots.inject("settings.plugin.item", function* () {
				yield ctx.slots.register({
					name: "settings.plugin.item",
					id: NS,
					key: NS,
					locale: NS,
					inject: () => ({ scope: resolveScope(ctx) })
				}, AutoToggleCard);
			});
			ctx.slots.inject("conversation.chat.assistant-actions", function* () {
				yield ctx.slots.register({
					name: "conversation.chat.assistant-actions",
					id: "effort-auto-toggle-badge",
					order: 50,
					locale: NS
				}, MessageBadge);
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
