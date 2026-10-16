# Agent Guild ロードマップ

Agent Guild は、AI 利用方針を掲載者が明示した OSS Issue を探し、成果を提出して検収する日本語中心のクエストボードです。掲載者・回答者とも無料で、有料プランは設けません。サービスのソースは MIT License で公開しています。

この文書は段階と判断条件の正本です。実作業と現在の状態は [ロードマップ Issue #1](https://github.com/maasa1221/agent-guild/issues/1) と各 Issue、[Project 1](https://github.com/users/maasa1221/projects/1) で管理します。Issue が閉じるまでは、予定を実装済みと扱いません。

## 現在地: 無料版の社内公開

**2026-10-14 の判断（#10）:** 判断者 maasa1221。無料版（報奨金・支払なし）を、社内メンバーだけが使える形で公開してよい。運用は本人の自己責任で行い、社外公開と実送金は対象外とする。公開の構成と手順は [公開手順](deploy.md) に記録した。#9 の USDC は保留のまま無効にする。

`main` には PR #19 で社内向け無料版の公開構成が入っています。報奨金とウォレットは既定で無効です。Caddy による接続元 IP の制限、GitHub 組織メンバーに限るログイン、systemd での起動、毎日の停止時バックアップ（直近 14 世代、同じ VM のディスク上）を含みます。アプリ本体には、公開 GitHub Issue の参照、検索と絞り込み、掲載者による AI 利用申告、複数回答からの検収対象選択、GitHub OAuth のサーバー側セッション、利用者 ID に基づく本人権限、SQLite 保存と旧 JSON 移行、監査記録、公開コメントの存在確認、投稿制限・通報・管理者による非表示があります。Issue #2〜#8 は closed、Project では Done です。

Google ログインと社内運用の必須設定は、作業ブランチの候補実装で、まだ `main` には入っていません。内容は次の Issue に対応します。

- [#20](https://github.com/maasa1221/agent-guild/issues/20): Google の ID を `google:<sub>` として GitHub の数値 ID と分け、監査に記録する。
- [#21](https://github.com/maasa1221/agent-guild/issues/21): 社内運用モードで、設定の欠落・一部だけ・例示値の場合は起動と導入を拒否する。
- [#23](https://github.com/maasa1221/agent-guild/issues/23): Google OIDC でログインし、許可した Workspace ドメインのアカウントだけを通す。

この候補は合成の利用者と合成署名のトークンでテストしただけで、Google と GitHub の実 grant、実環境への導入は検証していません。Node.js の最低版の判定は [#22](https://github.com/maasa1221/agent-guild/issues/22) で別に扱います。いずれも、レビューと merge が済むまで完了とは扱いません。

残る前提と制約は次のとおりです。

- **セッション**: サーバーのメモリにだけあり、最長 8 時間で切れます。再起動と毎朝のバックアップでも全員ログアウトします。組織メンバーかどうか、Google のドメインかどうかは、ログイン時にだけ確認します。
- **アカウント**: GitHub と Google のアカウントは統合しません。管理者は GitHub の数値 ID だけで指定します。
- **必須の入力**: 会社の Workspace ドメイン、GitHub 組織、公開ホスト名、社内 CIDR は利用者が決める値で、まだ決まっていません。推測した値では導入しません。
- **運用**: バックアップは同じ VM の上にしかありません。実環境での停止と復旧、監視、個人情報への対応は確認していません。
- **掲載**: maintainer 承認の申告と公開コメントの存在は区別しますが、コメント内容から許可を判断する処理は自動化していません。
- **USDC**: 状態遷移だけの mock で、無料版では無効です。チェーン接続、資金の預託、実送金はありません。社外公開や実資金の受け渡しには使えません。

## 段階と着手順

| 段階 | 現在の状態 | 到達条件と着手順 | 作業 Issue |
| --- | --- | --- | --- |
| M0 デモの検収改善 | ローカル実装完了 | 複数回答から1件を明示して検収し、失敗後の模擬支払再試行でも対象を固定する。 | [#2](https://github.com/maasa1221/agent-guild/issues/2) |
| M1 実用基盤 | ローカル実装完了 | サーバーセッション、SQLite 保存、掲載・納品・検収・取消の本人権限を API で強制する。実 OAuth 接続や本番 DB 運用は未検証。 | [#3](https://github.com/maasa1221/agent-guild/issues/3)、[#4](https://github.com/maasa1221/agent-guild/issues/4)、[#5](https://github.com/maasa1221/agent-guild/issues/5) |
| M2 信頼できる掲載・検収 | ローカル実装完了 | 競合と重複検収を防ぐ監査可能な状態遷移、AI 利用・承認証跡の確認、投稿乱用への停止手段を備える。公開運用の合格ではない。 | [#6](https://github.com/maasa1221/agent-guild/issues/6)、[#7](https://github.com/maasa1221/agent-guild/issues/7)、[#8](https://github.com/maasa1221/agent-guild/issues/8) |
| M3 USDC の可否判断 | 未決 / Todo | 法務、決済事業者、資産管理責任、本人確認、検収・紛争・返金、障害時対応を確認して可否を記録する。可能と判断された場合だけ、別 Issue で資金を扱わない sandbox 限定試験を定義する。 | [#9](https://github.com/maasa1221/agent-guild/issues/9) |
| M4 公開運用判断 | 社内限定で公開可（2026-10-14）。実環境での受入は未完了 | 無料版の社内公開構成は PR #19 で `main` に入った。Google/GitHub の SSO と社内運用の必須設定は候補実装で、レビューと merge を待つ。必須の入力が決まり、実環境での導入・ログイン・復旧を確認したら #10 を閉じられる。 | [#10](https://github.com/maasa1221/agent-guild/issues/10)、[#20](https://github.com/maasa1221/agent-guild/issues/20)、[#21](https://github.com/maasa1221/agent-guild/issues/21)、[#22](https://github.com/maasa1221/agent-guild/issues/22)、[#23](https://github.com/maasa1221/agent-guild/issues/23) |

[#1](https://github.com/maasa1221/agent-guild/issues/1) はロードマップ管理として open / Project Todo のままです。次のゲートは2つあり、**別々に判断**します。#9 は実送金の可否で、保留のままです。#10 は社内公開の受入で、実環境で確認するまで open のままにします。この文書は、Issue を閉じたり、社外公開や実送金を許可したりするものではありません。#10 の合成 DB 復元と既存認証・権限テストの照合結果、残る判断は [運用準備メモ](decision-readiness.md) に記録しています。

#10 の停止時復元と切り戻しの確認順は [復旧手順案](offline-recovery.md) に記録しています。合成データでの隔離復元までが確認済みで、実環境の停止・復旧、監視、運用責任者の判断は残っています。

## 判断と禁止事項

- 掲載者の AI 利用申告と、GitHub maintainer が実際に承認した事実を混同しません。証跡を確認できない場合は未確認と表示します。
- USDC 額と支払履歴は現在 mock です。OSS・無料・自己管理という理由だけで規制対象外とは判断しません。専門家と事業者の確認結果、責任者の承認が揃うまで実資金操作、mainnet 送信、鍵・資格情報の新規発行、契約は行いません。
- 公開ホスティングと第三者投稿の開始は #10 の判断後の別作業です。M1・M2 が完了しても自動的には公開しません。
- デモ用のローカルデータ、秘密値、個人情報をソースの公開履歴に加えません。
