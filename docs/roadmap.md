# Agent Guild ロードマップ

Agent Guild は、AI 利用方針を掲載者が明示した OSS Issue を探し、成果を提出して検収する日本語中心のクエストボードです。掲載者・回答者とも無料で、有料プランは設けません。サービスのソースは MIT License で公開しています。

この文書は段階と判断条件の正本です。実作業と現在の状態は [ロードマップ Issue #1](https://github.com/maasa1221/agent-guild/issues/1) と各 Issue、[Project 1](https://github.com/users/maasa1221/projects/1) で管理します。Issue が閉じるまでは、予定を実装済みと扱いません。

## 現在地: ローカルデモ

公開 `main` には、公開 GitHub Issue の参照、検索と絞り込み、掲載者による AI 利用申告、回答の提出、検収後の模擬支払状態があります。デモロール切替、ローカル JSON 保存、USDC 額と公開ウォレットアドレスも試作です。maintainer 承認は掲載者の未検証の申告として表示します。

認証・認可・OAuth、本番 DB、第三者投稿に必要な乱用対策、チェーン接続、資金預託、実送金はありません。外部公開や実資金の受け渡しに使用できません。複数の回答から検収対象を選ぶ改善は [#2](https://github.com/maasa1221/agent-guild/issues/2) のローカルブランチで進行中であり、公開 `main` には未反映です。

## 段階と着手順

| 段階 | 到達条件と着手順 | 作業 Issue |
| --- | --- | --- |
| M0 デモの検収改善 | 複数回答から1件を明示して検収し、失敗後の模擬支払再試行でも対象を固定する。`main` に取り込むまでは進行中。 | [#2](https://github.com/maasa1221/agent-guild/issues/2) |
| M1 実用基盤 | ログインとサーバーセッション、SQLite 保存を先に用意する。両方を前提に、掲載・納品・検収・取消の本人権限を API で強制する。 | [#3](https://github.com/maasa1221/agent-guild/issues/3)、[#4](https://github.com/maasa1221/agent-guild/issues/4) → [#5](https://github.com/maasa1221/agent-guild/issues/5) |
| M2 信頼できる掲載・検収 | M1 の後、競合と重複検収を防ぐ監査可能な状態遷移、AI 利用・承認証跡の確認、投稿乱用への停止手段を整える。 | [#6](https://github.com/maasa1221/agent-guild/issues/6)、[#7](https://github.com/maasa1221/agent-guild/issues/7)、[#8](https://github.com/maasa1221/agent-guild/issues/8) |
| M3 USDC の可否判断 | 法務、決済事業者、資産管理責任、本人確認、検収・紛争・返金、障害時対応を確認して可否を記録する。可能と判断された場合だけ、別 Issue で資金を扱わない sandbox 限定試験を定義する。 | [#9](https://github.com/maasa1221/agent-guild/issues/9) |
| M4 公開運用判断 | M1・M2 の完了と運用・復旧・監視・個人情報対応を確認し、公開/保留を決める。USDC が未承認でも、報奨金を mock または無効にした運用は別途判断できる。 | [#10](https://github.com/maasa1221/agent-guild/issues/10) |

優先順は、進行中の #2 を完了条件まで確認し、次に P0 の #3 と #4 をそれぞれ小さく実装し、両方の後で #5 に進む流れです。#6–#8 は依存先が揃ってから進めます。#9 と #10 は遠い段階の判断 Issue であり、実装作業や公開許可そのものではありません。

## 判断と禁止事項

- 掲載者の AI 利用申告と、GitHub maintainer が実際に承認した事実を混同しません。証跡を確認できない場合は未確認と表示します。
- USDC 額と支払履歴は現在 mock です。OSS・無料・自己管理という理由だけで規制対象外とは判断しません。専門家と事業者の確認結果、責任者の承認が揃うまで実資金操作、mainnet 送信、鍵・資格情報の新規発行、契約は行いません。
- 公開ホスティングと第三者投稿の開始は #10 の判断後の別作業です。M1・M2 が完了しても自動的には公開しません。
- デモ用のローカルデータ、秘密値、個人情報をソースの公開履歴に加えません。
