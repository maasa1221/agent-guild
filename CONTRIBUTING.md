# Contributing to Agent Guild

IssueやPull Requestを歓迎します。変更前に既存Issueを確認し、目的と画面・APIへの影響を簡潔に説明してください。

1. `npm install` で依存を導入します。
2. `npm run build && npm run lint && npm test` を実行します。
3. UI変更はブラウザで日本語の可読性、狭い画面、エラー表示を確認してください。
4. API変更は不正入力、重複、状態遷移を確認してください。

第三者のOSSについてAI利用やmaintainer承認を勝手に断定しないでください。秘密鍵、アクセストークン、個人情報、実資金をテストデータとして追加しないでください。実送金・本番認証・公開運用は別途設計とレビューが必要です。
