import {
	getUserSettings,
	saveTabsWithAutoCategory,
	updateDomainCategorySettings,
	migrateParentCategoriesToDomainNames,
	getParentCategories,
	type SubCategoryKeyword,
} from "../utils/storage";
import { defineBackground } from "wxt/sandbox";

// 型定義
interface TabGroup {
	id: string;
	domain: string;
	parentCategoryId?: string;
	urls: Array<{
		url: string;
		title: string;
		subCategory?: string;
		savedAt?: number; // 個別URL保存時刻
	}>;
	subCategories?: string[];
	categoryKeywords?: SubCategoryKeyword[];
	savedAt?: number; // グループ全体の保存時刻
}

interface ParentCategory {
	id: string;
	name: string;
	domains: string[];
	domainNames: string[];
}

export default defineBackground(() => {
	// ドラッグされたURL情報を一時保存するためのストア
	let draggedUrlInfo: {
		url: string;
		timestamp: number;
		processed: boolean; // 処理済みフラグを追加
	} | null = null;

	// バックグラウンド初期化時に一度だけマイグレーションを実行
	(async () => {
		try {
			console.log("バックグラウンド起動時のデータ構造チェックを開始...");

			// 既存のカテゴリを確認
			const categories = await getParentCategories();
			console.log("現在の親カテゴリ:", categories);

			// 強制的にマイグレーションを実行する
			console.log("親カテゴリのdomainNamesの強制マイグレーションを実行");
			await migrateParentCategoriesToDomainNames();

			// 移行後のデータを確認
			const updatedCategories = await getParentCategories();
			console.log("移行後の親カテゴリ:", updatedCategories);

			// 期限切れタブのチェック用アラームを設定
			setupExpiredTabsCheckAlarm();
		} catch (error) {
			console.error("バックグラウンド初期化エラー:", error);
		}
	})();

	// 期限切れタブのチェック用アラームを設定
	function setupExpiredTabsCheckAlarm() {
		try {
			console.log("期限切れタブのチェックアラームを設定しています...");

			// chrome.alarmsが利用可能か確認
			if (!chrome.alarms) {
				console.error(
					"chrome.alarms APIが利用できません。Manifest.jsonで権限を確認してください。",
				);
				// アラーム処理が使えない場合でも、初回のチェックは実行
				checkAndRemoveExpiredTabs();
				return;
			}

			// エラーハンドリングを追加してアラームを作成
			const createAlarm = () => {
				try {
					console.log("アラームを作成します");
					chrome.alarms.create("checkExpiredTabs", {
						periodInMinutes: 0.5, // 30秒間隔でテスト
					});
					console.log("アラームが作成されました");
				} catch (error) {
					console.error("アラーム作成エラー:", error);
				}
			};

			// 既存のアラームを確認
			chrome.alarms.get("checkExpiredTabs", (alarm) => {
				if (alarm) {
					console.log("既存のアラームを検出:", alarm);
					try {
						// 既存のアラームをクリア（必要に応じて）
						chrome.alarms.clear("checkExpiredTabs", (wasCleared) => {
							console.log("既存のアラームをクリア:", wasCleared);
							createAlarm();
						});
					} catch (error) {
						console.error("アラームクリアエラー:", error);
						// エラーが発生しても続行
						createAlarm();
					}
				} else {
					console.log("既存のアラームはありません");
					createAlarm();
				}
			});

			// アラームリスナーを登録
			chrome.alarms.onAlarm.addListener((alarm) => {
				console.log(
					`アラームが発火しました: ${alarm.name} (${new Date().toLocaleString()})`,
				);
				if (alarm.name === "checkExpiredTabs") {
					checkAndRemoveExpiredTabs();
				}
			});

			// 初回チェックは即時実行
			setTimeout(() => {
				checkAndRemoveExpiredTabs();
			}, 1000);
		} catch (error: unknown) {
			console.error(
				"アラーム設定エラー:",
				error instanceof Error ? error.message : error,
			);

			// エラーが発生しても初回チェックは実行
			setTimeout(() => {
				checkAndRemoveExpiredTabs();
			}, 1000);
		}
	}

	// 期限切れのタブをチェックして削除する関数
	async function checkAndRemoveExpiredTabs(forceReload = false) {
		try {
			console.log(
				"期限切れタブのチェックを開始...",
				new Date().toLocaleString(),
			);

			// ストレージから直接取得する - より単純化した取得方法
			const data = await chrome.storage.local.get(["userSettings"]);
			const settings = data.userSettings || { autoDeletePeriod: "never" };

			// デバッグログを追加
			console.log("ストレージから直接取得した設定:", data);
			console.log("使用する自動削除期間:", settings.autoDeletePeriod);

			// 自動削除が無効な場合は何もしない
			if (!settings.autoDeletePeriod || settings.autoDeletePeriod === "never") {
				console.log("自動削除は無効です");
				return;
			}

			// 期限をミリ秒で計算
			const expirationPeriod = getExpirationPeriodMs(settings.autoDeletePeriod);
			if (!expirationPeriod) {
				console.log("有効な期限が設定されていません");
				return;
			}

			const currentTime = Date.now();
			const cutoffTime = currentTime - expirationPeriod;
			console.log(`現在時刻: ${new Date(currentTime).toLocaleString()}`);
			console.log(`カットオフ時刻: ${new Date(cutoffTime).toLocaleString()}`);

			// 保存されたタブを取得
			const { savedTabs = [] } = await chrome.storage.local.get("savedTabs");
			if (!savedTabs || savedTabs.length === 0) {
				console.log("保存されたタブはありません");
				return;
			}

			console.log(`チェック対象タブグループ数: ${savedTabs.length}`);

			// 期限切れタブの詳細ログを出力
			savedTabs.forEach((group: TabGroup, index: number) => {
				const savedAtTime = group.savedAt || 0;
				const isExpired = savedAtTime < cutoffTime;
				console.log(
					`[${index}] グループ ${group.domain}: ` +
						`保存時刻=${new Date(savedAtTime).toLocaleString()}, ` +
						`URL数=${group.urls.length}, ` +
						`期限切れ=${isExpired}`,
				);
			});

			// 期限切れタブをフィルタリング
			const updatedTabs = savedTabs.filter((group: TabGroup) => {
				// 保存時刻がないグループは現在時刻を設定
				if (!group.savedAt) {
					group.savedAt = currentTime;
					return true;
				}

				// 期限切れチェックと詳細ログ
				const isGroupExpired = group.savedAt < cutoffTime;
				if (isGroupExpired) {
					console.log(
						`削除: グループ ${group.domain} (${group.urls.length}個のURL)`,
					);
					return false; // このグループは削除
				}
				return true;
			});

			// 変更があった場合のみ保存
			if (updatedTabs.length !== savedTabs.length) {
				console.log(`削除前: ${savedTabs.length} グループ`);
				console.log(`削除後: ${updatedTabs.length} グループ`);
				await chrome.storage.local.set({ savedTabs: updatedTabs });
				console.log("期限切れタブを削除しました");
			} else {
				console.log("削除対象のタブはありませんでした");
			}
		} catch (error: unknown) {
			console.error(
				"期限切れタブチェックエラー:",
				error instanceof Error ? error.message : error,
			);
		}
	}

	// 期限の文字列を対応するミリ秒に変換
	function getExpirationPeriodMs(period: string): number | null {
		const minute = 60 * 1000;
		const hour = 60 * minute;
		const day = 24 * hour;

		// テスト用に30秒も追加
		switch (period) {
			case "30sec":
				return 30 * 1000; // テスト用30秒
			case "1min":
				return minute;
			case "1hour":
				return hour;
			case "1day":
				return day;
			case "7days":
				return 7 * day;
			case "14days":
				return 14 * day;
			case "30days":
				return 30 * day;
			case "180days":
				return 180 * day; // 約6ヶ月
			case "365days":
				return 365 * day; // 1年
			default:
				return null; // "never" または無効な値
		}
	}

	// インストール時に実行する処理
	chrome.runtime.onInstalled.addListener(async () => {
		// コンテキストメニューを作成
		chrome.contextMenus?.create({
			id: "saveCurrentTab",
			title: "現在のタブを保存",
			contexts: ["page"],
		});

		chrome.contextMenus?.create({
			id: "saveAllTabs",
			title: "すべてのタブを保存",
			contexts: ["page"],
		});

		// データ構造の移行を実行
		try {
			console.log(
				"拡張機能インストール/更新時の親カテゴリデータ構造移行を開始...",
			);
			await migrateParentCategoriesToDomainNames();
			console.log("データ構造の移行が完了しました");
		} catch (error) {
			console.error("データ構造の移行に失敗しました:", error);
		}
	});

	// ブラウザアクション（拡張機能アイコン）クリック時の処理
	chrome.action.onClicked.addListener(async () => {
		console.log("拡張機能アイコンがクリックされました");

		try {
			const settings = await getUserSettings();
			// 現在のウィンドウのタブをすべて取得
			const allTabs = await chrome.tabs.query({ currentWindow: true });
			console.log(`取得したタブ: ${allTabs.length}個`);

			// 拡張機能のタブを除外
			const regularTabs = allTabs.filter((tab) => {
				if (!tab.url) return false;
				return !settings.excludePatterns.some((pattern) =>
					tab.url?.includes(pattern),
				);
			});
			console.log(`保存対象タブ: ${regularTabs.length}個`);

			// タブを保存して自動カテゴライズする
			await saveTabsWithAutoCategory(regularTabs);
			console.log("タブの保存と自動カテゴライズが完了しました");

			// 保存完了通知を表示
			chrome.notifications?.create({
				type: "basic",
				iconUrl: "/assets/react.svg",
				title: "タブ保存",
				message: `${regularTabs.length}個のタブが保存されました。タブを閉じます。`,
			});

			// 保存されたタブを表示するページを開く
			const savedTabsUrl = chrome.runtime.getURL("saved-tabs.html");
			console.log("開くURL:", savedTabsUrl);

			// 既存のsaved-tabsページを探す
			const existingTabs = await chrome.tabs.query({ url: savedTabsUrl });
			let savedTabsTabId: number | undefined;

			if (existingTabs.length > 0) {
				console.log("既存のタブを表示します:", existingTabs[0].id);
				savedTabsTabId = existingTabs[0].id;
				if (savedTabsTabId)
					await chrome.tabs.update(savedTabsTabId, { active: true });
			} else {
				console.log("新しいタブを作成します");
				const newTab = await chrome.tabs.create({ url: savedTabsUrl });
				savedTabsTabId = newTab.id;
				if (savedTabsTabId) {
					console.log("新しいタブをピン留めします:", savedTabsTabId);
					await chrome.tabs.update(savedTabsTabId, { pinned: true });
				}
			}

			// 閉じるタブを収集 (chrome-extension:// と saved-tabs.html を除く)
			const tabIdsToClose: number[] = [];

			for (const tab of allTabs) {
				// 次の条件を満たすタブのみ閉じる:
				// 1. タブIDが存在する
				// 2. saved-tabsページではない
				// 3. chrome-extensionではない
				if (
					tab.id &&
					tab.id !== savedTabsTabId &&
					tab.url &&
					!settings.excludePatterns.some((pattern) =>
						tab.url?.includes(pattern),
					)
				) {
					tabIdsToClose.push(tab.id);
				}
			}

			// タブを閉じる
			if (tabIdsToClose.length > 0) {
				console.log(
					`${tabIdsToClose.length}個のタブを閉じます:`,
					tabIdsToClose,
				);

				// タブを一つずつ閉じるためのループ（エラーハンドリングのため）
				for (const tabId of tabIdsToClose) {
					try {
						await chrome.tabs.remove(tabId);
						console.log(`タブID ${tabId} を閉じました`);
					} catch (error: unknown) {
						console.error(
							`タブID ${tabId} を閉じる際にエラーが発生しました:`,
							error instanceof Error ? error.message : error,
						);
					}
				}

				console.log("すべてのタブを閉じました");
			} else {
				console.log("閉じるべきタブはありません");
			}
		} catch (error: unknown) {
			console.error(
				"エラーが発生しました:",
				error instanceof Error ? error.message : error,
			);
		}
	});

	// タブの保存時刻を指定の期間に応じて更新する関数
	async function updateTabTimestamps(period?: string) {
		try {
			console.log(`タブの保存時刻を更新します: ${period || "不明な期間"}`);

			const { savedTabs = [] } = await chrome.storage.local.get("savedTabs");
			if (savedTabs.length === 0) {
				console.log("保存されたタブがありません");
				return;
			}

			const now = Date.now();
			let timestamp: number;

			// テスト用設定の場合は現在時刻より前に設定
			if (period === "30sec") {
				// 30秒前に設定（テスト用）
				timestamp = now - 40 * 1000; // 余裕を持って40秒前
				console.log(
					`保存時刻を30秒前に設定: ${new Date(timestamp).toLocaleString()}`,
				);
			} else if (period === "1min") {
				// 1分10秒前に設定（テスト用）
				timestamp = now - 70 * 1000; // 余裕を持って70秒前
				console.log(
					`保存時刻を1分10秒前に設定: ${new Date(timestamp).toLocaleString()}`,
				);
			} else {
				// デフォルトは現在時刻
				timestamp = now;
				console.log(
					`保存時刻を現在時刻に設定: ${new Date(timestamp).toLocaleString()}`,
				);
			}

			// タブの保存時刻を更新
			const updatedTabs = savedTabs.map((group: TabGroup) => ({
				...group,
				savedAt: timestamp,
			}));

			// ストレージに保存
			await chrome.storage.local.set({ savedTabs: updatedTabs });
			console.log(
				`${updatedTabs.length}個のタブグループの時刻を ${new Date(timestamp).toLocaleString()} に更新しました`,
			);

			// 即座に確認
			checkAndRemoveExpiredTabs();

			return { success: true, timestamp };
		} catch (error) {
			console.error("タブ時刻更新エラー:", error);
			throw error;
		}
	}

	// メッセージリスナーを追加
	chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
		console.log("バックグラウンドがメッセージを受信:", message);

		// URLのドラッグ開始を処理
		if (message.action === "urlDragStarted") {
			console.log("ドラッグ開始を検知:", message.url);
			// ドラッグ情報を一時保存
			draggedUrlInfo = {
				url: message.url,
				timestamp: Date.now(),
				processed: false,
			};

			// 10秒後に情報を自動消去（タイムアウト）
			setTimeout(() => {
				if (
					draggedUrlInfo &&
					draggedUrlInfo.timestamp === Date.now() &&
					!draggedUrlInfo.processed
				) {
					console.log("ドラッグ情報のタイムアウト:", draggedUrlInfo.url);
					draggedUrlInfo = null;
				}
			}, 10000);

			sendResponse({ status: "ok" });
			return true;
		}

		// ドラッグ&ドロップ後のURL処理
		if (message.action === "urlDropped") {
			console.log("URLドロップを検知:", message.url);

			// fromExternal フラグが true の場合のみ処理（外部ドラッグの場合のみ）
			if (message.fromExternal === true) {
				getUserSettings().then((settings) => {
					if (settings.removeTabAfterOpen) {
						removeUrlFromStorage(message.url)
							.then(() => {
								console.log("外部ドロップ後にURLを削除しました:", message.url);
								sendResponse({ status: "removed" });
							})
							.catch((error) => {
								console.error("URL削除エラー:", error);
								sendResponse({ status: "error", error: error.toString() });
							});
					} else {
						console.log("設定により削除をスキップ");
						sendResponse({ status: "skipped" });
					}
				});
			} else {
				console.log("内部操作のため削除をスキップ");
				sendResponse({ status: "internal_operation" });
			}
			return true; // 非同期応答のため
		}

		// URLをストレージから削除
		if (message.action === "removeUrlFromStorage") {
			removeUrlFromStorage(message.url)
				.then(() => sendResponse({ status: "removed" }))
				.catch((error) => sendResponse({ status: "error", error }));
			return true; // 非同期応答のため
		}

		// 残り時間計算リクエストの処理
		if (message.action === "calculateTimeRemaining") {
			const { savedAt, autoDeletePeriod } = message;

			if (!autoDeletePeriod || autoDeletePeriod === "never" || !savedAt) {
				sendResponse({ timeRemaining: null });
				return true;
			}

			try {
				const expirationMs = getExpirationPeriodMs(autoDeletePeriod);
				if (!expirationMs) {
					sendResponse({ timeRemaining: null });
					return true;
				}

				const now = Date.now();
				const expirationTime = savedAt + expirationMs;
				const remainingMs = expirationTime - now;

				sendResponse({
					timeRemaining: remainingMs,
					expirationTime,
				});
			} catch (error) {
				console.error("残り時間計算エラー:", error);
				sendResponse({ error: error?.toString() });
			}

			return true; // 非同期応答のため
		}

		// 期限切れタブのチェックを即時実行
		if (message.action === "checkExpiredTabs") {
			console.log("明示的な期限切れチェックリクエストを受信:", message);

			// 設定情報も出力
			chrome.storage.local.get(["userSettings"], (data) => {
				console.log("現在のストレージ内の設定:", data);
			});

			// updateTimestampsフラグがあり、periodも指定されている場合は時刻を更新
			if (message.updateTimestamps) {
				console.log(`タブの保存時刻を更新します (${message.period || "不明"})`);
				// 処理の簡略化 - まずタイムスタンプを更新し、待機せずにチェック実行
				updateTabTimestamps(message.period)
					.then((result) => {
						console.log("タブの時刻更新完了。チェックを実行します。");

						// 設定を再読み込みし、チェック実行
						checkAndRemoveExpiredTabs(true)
							.then(() => {
								console.log("期限切れチェック完了");
								sendResponse({ status: "completed", success: true });
							})
							.catch((error) => {
								console.error("チェックエラー:", error);
								sendResponse({ error: String(error) });
							});
					})
					.catch((error) => {
						console.error("タイムスタンプ更新エラー:", error);
						sendResponse({ error: String(error) });
					});
			} else {
				// 単純化 - 常に強制リロードする
				checkAndRemoveExpiredTabs(true)
					.then(() => {
						console.log("期限切れチェック完了");
						sendResponse({ status: "completed" });
					})
					.catch((error) => sendResponse({ error: String(error) }));
			}
			return true;
		}

		// 強制的にタブの保存時刻を更新するメッセージ
		if (message.action === "updateTabTimestamps") {
			console.log("タブの保存時刻を強制的に更新:", message.period);
			updateTabTimestamps(message.period)
				.then((result) => {
					sendResponse({ status: "completed", result });
				})
				.catch((error) => {
					console.error("時刻更新エラー:", error);
					sendResponse({ error: String(error) });
				});
			return true;
		}

		// 現在のアラーム状態を確認
		if (message.action === "getAlarmStatus") {
			chrome.alarms.get("checkExpiredTabs", (alarm) => {
				const status = alarm
					? { exists: true, scheduledTime: alarm.scheduledTime }
					: { exists: false };
				console.log("アラーム状態:", status);
				sendResponse(status);
			});
			return true;
		}
	});

	// 新しいタブが作成されたときの処理
	chrome.tabs.onCreated.addListener(async (tab) => {
		console.log("新しいタブが作成されました:", tab.url);

		// ドラッグされた情報が存在するか確認
		if (draggedUrlInfo && !draggedUrlInfo.processed) {
			console.log("ドラッグ情報が存在します:", draggedUrlInfo.url);
			console.log("新しいタブのURL:", tab.url);

			// URLを正規化して比較
			const normalizedDraggedUrl = normalizeUrl(draggedUrlInfo.url);
			const normalizedTabUrl = normalizeUrl(tab.url || "");

			console.log("正規化されたドラッグURL:", normalizedDraggedUrl);
			console.log("正規化された新タブURL:", normalizedTabUrl);

			// URLが類似していれば処理
			if (
				normalizedTabUrl &&
				normalizedDraggedUrl &&
				(normalizedTabUrl === normalizedDraggedUrl ||
					normalizedTabUrl.includes(normalizedDraggedUrl) ||
					normalizedDraggedUrl.includes(normalizedTabUrl))
			) {
				console.log("URLが一致または類似しています");

				try {
					// 処理済みとマーク
					draggedUrlInfo.processed = true;

					const settings = await getUserSettings();
					if (settings.removeTabAfterOpen) {
						console.log("設定に基づきURLを削除します:", draggedUrlInfo.url);
						await removeUrlFromStorage(draggedUrlInfo.url);
					} else {
						console.log("設定により削除をスキップします");
					}
				} catch (error) {
					console.error("タブ作成後の処理でエラー:", error);
				} finally {
					// 処理完了後、ドラッグ情報をクリア
					draggedUrlInfo = null;
				}
			} else {
				console.log("URLが一致しません。削除をスキップします");
			}
		}
	});

	// URLを正規化する関数（比較のため）
	function normalizeUrl(url: string): string {
		try {
			// 不要なパラメータやフラグメントを取り除く
			return url.trim().toLowerCase().split("#")[0].split("?")[0];
		} catch {
			return url.toLowerCase();
		}
	}

	// URLをストレージから削除する関数（カテゴリ設定とマッピングを保持）
	// TabGroupが空になった時の処理関数
	async function handleTabGroupRemoval(groupId: string) {
		console.log(`空になったグループの処理を開始: ${groupId}`);
		await removeFromParentCategories(groupId);
		console.log(`グループ ${groupId} の処理が完了しました`);
	}

	async function removeUrlFromStorage(url: string) {
		try {
			const { savedTabs = [] } = await chrome.storage.local.get("savedTabs");

			// URLを含むグループを更新
			const updatedGroups = savedTabs
				.map((group: TabGroup) => {
					const updatedUrls = group.urls.filter((item) => item.url !== url);
					if (updatedUrls.length === 0) {
						// グループが空になる場合は専用の処理関数を呼び出し
						handleTabGroupRemoval(group.id);
						return null; // 空グループを削除
					}
					return { ...group, urls: updatedUrls };
				})
				.filter(Boolean);

			// 更新したグループをストレージに保存
			await chrome.storage.local.set({ savedTabs: updatedGroups });
			console.log(`ストレージからURL ${url} を削除しました`);
		} catch (error) {
			console.error("URLの削除中にエラーが発生しました:", error);
			throw error;
		}
	}

	// ドメインの設定を永続化する関数
	async function saveDomainSettings(
		domain: string,
		subCategories: string[],
		categoryKeywords: SubCategoryKeyword[],
	) {
		try {
			// domainが実際のURLドメインでなければ処理しない
			if (!domain.includes("://")) return;

			await updateDomainCategorySettings(
				domain,
				subCategories,
				categoryKeywords,
			);
			console.log(`ドメイン ${domain} のカテゴリ設定を永続化しました`);
		} catch (error) {
			console.error("カテゴリ設定の永続化エラー:", error);
		}
	}

	// グループを親カテゴリから削除する関数を更新
	async function removeFromParentCategories(groupId: string) {
		try {
			const { parentCategories = [] } =
				await chrome.storage.local.get("parentCategories");

			// 削除対象のドメイン名を取得
			const { savedTabs = [] } = await chrome.storage.local.get("savedTabs");
			const groupToRemove = savedTabs.find(
				(group: TabGroup) => group.id === groupId,
			);
			const domainName = groupToRemove?.domain;

			if (!groupToRemove || !domainName) {
				console.log(
					`削除対象のグループID ${groupId} が見つからないか、ドメイン名がありません`,
				);
				return;
			}

			console.log(
				`カテゴリから削除: グループID ${groupId}, ドメイン ${domainName}`,
			);

			// ドメイン名を保持したままドメインIDのみを削除
			const updatedCategories = parentCategories.map(
				(category: ParentCategory) => {
					// domainNamesは変更せず、domainsからIDのみを削除
					const updated = {
						...category,
						domains: category.domains.filter((id: string) => id !== groupId),
					};

					// ドメイン名がdomainNamesにあるか確認してログ出力
					if (category.domainNames && Array.isArray(category.domainNames)) {
						if (category.domainNames.includes(domainName)) {
							console.log(
								`ドメイン名 ${domainName} は ${category.name} のdomainNamesに保持されます`,
							);
						}
					}

					return updated;
				},
			);

			await chrome.storage.local.set({ parentCategories: updatedCategories });

			// 必要ならドメイン-カテゴリのマッピングを更新（削除しない）
			if (groupToRemove.parentCategoryId) {
				console.log(
					`ドメイン ${domainName} のマッピングを親カテゴリ ${groupToRemove.parentCategoryId} に保持します`,
				);
			}

			console.log(
				`カテゴリからグループID ${groupId} を削除しました（ドメイン名を保持）`,
			);
		} catch (error: unknown) {
			console.error(
				"親カテゴリからの削除中にエラーが発生しました:",
				error instanceof Error ? error.message : error,
			);
		}
	}

	// コンテキストメニューの処理
	if (chrome.contextMenus?.onClicked) {
		chrome.contextMenus.onClicked.addListener(async (info, tab) => {
			if (info.menuItemId === "saveCurrentTab" && tab) {
				// 単一タブ保存時も自動カテゴライズ
				await saveTabsWithAutoCategory([tab]);
				chrome.notifications?.create({
					type: "basic",
					iconUrl: "/assets/react.svg",
					title: "タブ保存",
					message: "現在のタブが保存されました",
				});
			} else if (info.menuItemId === "saveAllTabs") {
				const tabs = await chrome.tabs.query({ currentWindow: true });
				// 複数タブ保存時も自動カテゴライズ
				await saveTabsWithAutoCategory(tabs);
				chrome.notifications?.create({
					type: "basic",
					iconUrl: "/assets/react.svg",
					title: "タブ保存",
					message: `${tabs.length}個のタブが保存されました`,
				});
			}
		});
	}
});
