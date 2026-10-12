# Agent Guild ロードマップ

Agent Guild は、AI 利用方針を掲載者が明示した OSS Issue を探し、成果を提出して検収する日本語中心のクエストボードです。掲載者・回答者とも無料で、有料プランは設けません。サービスのソースは MIT License で公開しています。

この文書は段階と判断条件の正本です。実作業と現在の状態は [ロードマップ Issue #1](https://github.com/maasa1221/agent-guild/issues/1) と各 Issue、[Project 1](https://github.com/users/maasa1221/projects/1) で管理します。Issue が閉じるまでは、予定を実装済みと扱いません。

## 現在地: ローカルデモ

公開 `main`（照合版 `124fef9`）には、公開 GitHub Issue の参照、検索と絞り込み、掲載者による AI 利用申告、複数回答からの検収対象選択、検収後の模擬支払状態があります。GitHub OAuth のサーバー側セッション、利用者 ID に基づく本人権限、SQLite 保存と旧 JSON 移行、監査記録、公開コメントの存在確認、投稿制限・通報・管理者による非表示もローカル実装に入りました。Issue #2〜#8 は closed、Project では Done です。

GitHub OAuth の実アカウント接続には既存 OAuth App の設定が必要で、この開発では実 grant を検証していません。セッションはメモリに保持され、再起動で失効します。SQLite の定期バックアップや公開運用としての復旧・監視・個人情報対応は未整備です。maintainer 承認の申告と公開コメントの存在は区別しますが、コメント内容による許可の判断は自動化していません。USDC は状態遷移だけの mock で、チェーン接続、資金預託、実送金はありません。外部公開や実資金の受け渡しには使用できません。

## 段階と着手順

| 段階 | 現在の状態 | 到達条件と着手順 | 作業 Issue |
| --- | --- | --- | --- |
| M0 デモの検収改善 | ローカル実装完了 | 複数回答から1件を明示して検収し、失敗後の模擬支払再試行でも対象を固定する。 | [#2](https://github.com/maasa1221/agent-guild/issues/2) |
| M1 実用基盤 | ローカル実装完了 | サーバーセッション、SQLite 保存、掲載・納品・検収・取消の本人権限を API で強制する。実 OAuth 接続や本番 DB 運用は未検証。 | [#3](https://github.com/maasa1221/agent-guild/issues/3)、[#4](https://github.com/maasa1221/agent-guild/issues/4)、[#5](https://github.com/maasa1221/agent-guild/issues/5) |
| M2 信頼できる掲載・検収 | ローカル実装完了 | 競合と重複検収を防ぐ監査可能な状態遷移、AI 利用・承認証跡の確認、投稿乱用への停止手段を備える。公開運用の合格ではない。 | [#6](https://github.com/maasa1221/agent-guild/issues/6)、[#7](https://github.com/maasa1221/agent-guild/issues/7)、[#8](https://github.com/maasa1221/agent-guild/issues/8) |
| M3 USDC の可否判断 | 未決 / Todo | 法務、決済事業者、資産管理責任、本人確認、検収・紛争・返金、障害時対応を確認して可否を記録する。可能と判断された場合だけ、別 Issue で資金を扱わない sandbox 限定試験を定義する。 | [#9](https://github.com/maasa1221/agent-guild/issues/9) |
| M4 公開運用判断 | 未決 / Todo | M1・M2 の残余リスクと運用・復旧・監視・個人情報対応を確認し、公開/保留を決める。USDC が未承認でも、報奨金を mock または無効にした運用は別途判断できる。 | [#10](https://github.com/maasa1221/agent-guild/issues/10) |

[#1](https://github.com/maasa1221/agent-guild/issues/1) はロードマップ管理として open / Project Todo のままです。次のゲートは #9 の実送金可否と #10 の公開運用可否の**別々の判断**です。いずれも open / Project Todo であり、Issue を閉じたり公開・実送金を許可したりするものではありません。#10 の合成 DB 復元と既存認証・権限テストの照合結果、残る判断は [運用準備メモ](decision-readiness.md) に記録しています。

## 判断と禁止事項

- 掲載者の AI 利用申告と、GitHub maintainer が実際に承認した事実を混同しません。証跡を確認できない場合は未確認と表示します。
- USDC 額と支払履歴は現在 mock です。OSS・無料・自己管理という理由だけで規制対象外とは判断しません。専門家と事業者の確認結果、責任者の承認が揃うまで実資金操作、mainnet 送信、鍵・資格情報の新規発行、契約は行いません。
- 公開ホスティングと第三者投稿の開始は #10 の判断後の別作業です。M1・M2 が完了しても自動的には公開しません。
- デモ用のローカルデータ、秘密値、個人情報をソースの公開履歴に加えません。
