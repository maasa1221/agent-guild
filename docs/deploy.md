# 社内向け無料版の公開手順

Agent Guild の無料版（報奨金・支払なし）を、社内メンバーだけが使えるように無料の VM で公開する手順です。#10 の判断（社内限定・自己責任、2026-10-14）に基づきます。USDC 報奨金は #9 で保留中のため無効です。

## 構成

```
社内ネットワーク ──HTTPS──▶ [クラウドのファイアウォール: 443 は社内 IP だけ]
                            ▶ Caddy（自動証明書、remote_ip で社内 IP 以外は 403）
                            ▶ Node サーバー 127.0.0.1:46077（GitHub 組織メンバーまたは許可 Workspace ドメインの Google アカウントでログイン必須）
                            ▶ /opt/agent-guild/data/listings.sqlite（毎日 4:00 に停止時バックアップ）
```

アクセス制御は3段です。

1. **ファイアウォール**: 443 番は社内 IP からだけ受け付ける。
2. **Caddy**: 社内 IP 以外には 403 を返す。`remote_ip` は Caddy に直接つないだ接続元の IP だけを見ます。`X-Forwarded-For` などの転送ヘッダーは信用しません。Node サーバーも 127.0.0.1 だけで待ち受け、転送ヘッダーで利用者や IP を判断しません。前段に proxy・CDN・ロードバランサーを追加すると、Caddy から見える接続元がその中継になり IP 制限が働かなくなります。追加する場合は構成から設計し直してください。
3. **アプリ**: 閲覧も含めて全ページでログインを必須にする。未ログインの利用者には、設定済みの provider（GitHub / Google）を選ぶログイン画面だけを返し、一覧などのデータは返さない。
   - GitHub: `AGENT_GUILD_GITHUB_ORG` の有効なメンバー以外は 403。組織が SAML SSO を使う場合、初回ログインで SSO の認可を求められる。
   - Google: ID token の署名済み `hd` と確認済みメールのドメインが、どちらも `AGENT_GUILD_GOOGLE_DOMAINS` のどれかと完全一致する場合だけ許可する。個人の Gmail、許可外の Workspace、サブドメイン、未確認メールは 403。

アプリは systemd から `AGENT_GUILD_INTERNAL=1`（社内運用モード）で起動します。HTTPS の `AGENT_GUILD_ORIGIN` を設定した場合も同じ扱いです。このモードでは、下の必須設定が1つでも空・一部だけ・例示値のままだと、待ち受けを始める前に終了します。GitHub だけ、組織なしの GitHub、Google だけで動かすことはできません。

## 無料で使えるホスティング

SQLite をディスクに残す必要があるため、永続ディスクのない無料枠（Render の無料 Web Service、Cloud Run など）は使いません。再起動のたびにデータが消えるためです。

| 候補 | 費用 | 向き・注意 |
| --- | --- | --- |
| **Oracle Cloud Always Free（推奨）** | 無料 | 東京リージョンを選べる。AMD の VM.Standard.E2.1.Micro（1 GB）で動く。ビルド時のメモリ不足に備えて、`setup.sh` が swap を作る。登録にクレジットカードが必要。Ubuntu イメージは OS の iptables でも 80/443 を閉じているので、下の手順で開ける。 |
| GCP Always Free e2-micro | 無料 | 米国の対象リージョン（us-west1 など）に限られる。日本からは遅延が少し増える。標準永続ディスク 30 GB まで無料。 |
| 社内の常時稼働 PC・サーバー | 無料 | 同じ手順で動く。社内 LAN だけで使う場合、HTTPS 証明書の取得方法は別途決める。 |

アカウント作成、VM 作成、GitHub OAuth App と Google OAuth クライアントの発行は、利用者本人（Google は Workspace 管理者）が行ってください。

## 手順

### 1. VM とネットワーク

- Ubuntu 22.04 または 24.04 の VM を作る。
- ファイアウォール（Oracle は VCN のセキュリティリスト、GCP は VPC ファイアウォール）を次のように設定する。
  - **22**: 自分の IP だけ許可する。
  - **443**: 社内の接続元 IP だけ許可する。
  - **80**: 全体に許可する。Let's Encrypt の証明書発行に使う。Caddy は 80 番では HTTPS への転送と証明書の確認応答だけを返す。
- Oracle の Ubuntu イメージは、OS 内の iptables でも 80/443 を開ける必要がある。

  ```bash
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
  ```

### 2. ドメイン

- 社内ドメインのサブドメイン（例: `agent-guild.example.co.jp`）の A レコードを、VM のパブリック IP に向ける。
- 社内ドメインを使えない場合は、IP を埋め込んだ無料のホスト名 `<IPのドットをハイフンにしたもの>.sslip.io` も使える（例: `203-0-113-10.sslip.io`）。

### 3. GitHub OAuth App

- 組織の **Settings → Developer settings → OAuth Apps → New OAuth App** で作成する。
  - Homepage URL: `https://<ドメイン>`
  - Authorization callback URL: `https://<ドメイン>/api/auth/callback`
- Client ID と、生成した Client secret を控える。secret はリポジトリ、チャット、Issue に書かない。
- 組織で OAuth App のアクセス制限（Third-party application access policy）を有効にしている場合は、組織オーナーがこの App を承認する。
- アプリはログイン時に `read:org` を要求し、組織メンバーかどうかを確認する。

### 3b. Google OAuth クライアント

- 会社の Google Cloud プロジェクトで、OAuth 同意画面を **内部（Internal）** にし、**認証情報 → OAuth クライアント ID → ウェブアプリケーション** で作成する。作成と承認は Workspace の管理者が行う。
  - 承認済みのリダイレクト URI: `https://<ドメイン>/api/auth/google/callback`（完全一致。末尾のスラッシュなし）
  - スコープは `openid` と `email` だけ。アプリはこれ以外を要求せず、オフラインアクセス（refresh token）も要求しない。
- Client ID と Client secret を控える。secret はリポジトリ、チャット、Issue に書かない。
- `AGENT_GUILD_GOOGLE_DOMAINS` に、ログインを許可する Workspace の主ドメインを小文字・カンマ区切りで入れる。実際の値は会社で決める。サブドメインやワイルドカードは使えない。
- アプリは認可コードを state・一時 Cookie・PKCE S256・nonce と照合してサーバー側で交換する。Google の固定の公開鍵（JWKS）で ID token の署名、issuer、audience、azp、期限、nonce、`email_verified`、`hd` を検証する。ID token と access token は検証後に破棄し、保存もログ出力もしない。
- Google のメールは表示名としてだけ扱う。GitHub アカウントと同じメールでも自動で統合せず、別の利用者になる。

### 4. サーバーの設定と起動

```bash
sudo git clone https://github.com/maasa1221/agent-guild.git /opt/agent-guild
sudo install -d -m 700 /etc/agent-guild
sudo cp /opt/agent-guild/deploy/app.env.example /etc/agent-guild/app.env
sudo cp /opt/agent-guild/deploy/caddy.env.example /etc/agent-guild/caddy.env
sudo nano /etc/agent-guild/app.env     # ORIGIN、GitHub/Google の Client ID/secret、組織名、Workspace ドメイン、管理者 ID
sudo nano /etc/agent-guild/caddy.env   # ドメイン、社内 IP（CIDR、空白区切り）
sudo bash /opt/agent-guild/deploy/setup.sh
```

本番の `data/` は空の状態から始めてください。ローカルデモの DB を持ち込むと、報奨金付きの掲載は無料版では検収・取消できません。

`setup.sh` は最初に `deploy/preflight.sh` で設定ファイルだけを検査し、問題があれば何も変更せずに終了します。表示するのは項目名だけで、秘密値は表示しません。検査内容は次のとおりです。

- 下の必須設定がすべてあり、空・例示値でないこと。
- `AGENT_GUILD_ORIGIN` が `https://<AGENT_GUILD_DOMAIN>` と一致すること。
- 組織名と Workspace ドメインの形式が正しいこと。
- 任意の投稿制限（`AGENT_GUILD_POST_LIMIT`・`AGENT_GUILD_POST_WINDOW_MS`）が、空か範囲内の 10 進の整数であること。
- `AGENT_GUILD_ALLOWED_IPS` が空でなく、正しい IPv4 / IPv6 アドレスか CIDR だけであること。prefix 0（`/0`・`/00` など）、先頭が 0 の prefix や IPv4 octet（`/08`・`010.0.0.1`）、未指定アドレス（`0.0.0.0`・`::`）、文書用の例示範囲、IPv4 埋め込み形式の IPv6（`::ffff:10.0.0.1`）は拒否する。

検査に通ると、次を行います。

- メモリが 2 GB 未満で swap がなければ、ビルド用に 2 GB の swap を作る。
- Node.js 22 と Caddy を入れる。
- 専用ユーザー `agentguild` を作る。
- `npm ci` とビルドを行う。
- systemd サービス、日次バックアップのタイマー、Caddy の設定を配置して起動する。

管理者 ID は GitHub の数値 ID です。ブラウザで `https://api.github.com/users/<ログイン名>` を開くと確認できます。Google アカウントは管理者に指定できません。Google のメールや sub は管理者判定に使いません。Google の管理者が必要になったら、別途仕様を決めます。

### 設定一覧と拒否時の対処

| ファイル | 項目 | 内容 |
| --- | --- | --- |
| app.env | `AGENT_GUILD_ORIGIN` | `https://<AGENT_GUILD_DOMAIN>`。HTTPS 以外・例示値は拒否。 |
| app.env | `AGENT_GUILD_GITHUB_CLIENT_ID` / `AGENT_GUILD_GITHUB_CLIENT_SECRET` | GitHub OAuth App。両方必須。 |
| app.env | `AGENT_GUILD_GITHUB_ORG` | 許可する GitHub 組織。必須。`your-org` のままは拒否。 |
| app.env | `AGENT_GUILD_GOOGLE_CLIENT_ID` / `AGENT_GUILD_GOOGLE_CLIENT_SECRET` / `AGENT_GUILD_GOOGLE_DOMAINS` | Google OAuth クライアントと許可 Workspace ドメイン。3つとも必須。一部だけ、空の項目、不正な形式、例示ドメインは拒否。 |
| app.env | `AGENT_GUILD_ADMIN_IDS` | 管理者の GitHub 数値 ID。任意。 |
| app.env | `AGENT_GUILD_POST_LIMIT` / `AGENT_GUILD_POST_WINDOW_MS` | 投稿制限の件数（1〜100）と期間（1000〜86400000 ms）。任意。未設定・空は 5 件 / 60000 ms。10 進の整数（先頭の `+` と 0 は可）以外と範囲外は、事前確認と起動の両方で拒否。 |
| caddy.env | `AGENT_GUILD_DOMAIN` | 公開するホスト名。 |
| caddy.env | `AGENT_GUILD_ALLOWED_IPS` | 社内の接続元 IP / CIDR。空白区切り。 |

拒否されたときは、表示された項目名を `/etc/agent-guild/*.env` で実際の値に直して `setup.sh` を再実行してください。サービスが起動しない場合は `journalctl -u agent-guild` に項目名が出ます。会社のドメイン、GitHub 組織、公開先、社内 CIDR は推測で埋めず、決まるまで導入を止めてください。

アカウントの自動作成（provisioning）や事前登録はありません。ログイン時に上の条件を満たした利用者が、そのまま使えます。

### 5. 確認

- 社外の回線（携帯回線など）から開くと 403 になること。
- 社内から開くとログイン画面に GitHub と Google の両方が表示され、組織メンバー（GitHub）または許可ドメインのアカウント（Google）なら一覧が表示されること。
- 組織外の GitHub アカウント、許可外ドメインや個人の Google アカウントでログインすると 403 になること。
- 実アカウントでの確認結果は、合成テストの結果と分けて記録すること。
- 掲載画面に報奨金の入力欄がなく、上部に「無料版」と表示されること。

## 運用

- **更新**: 次のコマンドで更新する。セッションはメモリ上にあるため、再起動すると全員ログアウトする。

  ```bash
  cd /opt/agent-guild && sudo git pull && sudo bash deploy/setup.sh
  ```

- **ログ**: `journalctl -u agent-guild -u caddy`
- **バックアップ**:
  - 毎日 4:00（VM のタイムゾーン）に数秒サービスを止め、`data/` を `/var/backups/agent-guild/<日時>` にコピーする。直近 14 世代を残す。セッションはメモリ上にあるので、このとき全員ログアウトされる。意図して停止中のサービスは、バックアップ後も起動しない。
  - 手動で取るときは `sudo systemctl start agent-guild-backup` を実行する。
  - バックアップは同じ VM のディスク上にあるので、VM ごと失うと戻せない。重要になったら別の保管先へのコピーを足す。
- **復元**: [復旧手順案](offline-recovery.md) のとおり、サービスを止め、バックアップを隔離先で確認してから `data/` を差し替える。
- **保存データ**: 何が保存されているかは [運用準備メモの保存データの棚卸し](decision-readiness.md) と `server/data-inventory.mjs` を参照する。
- **停止**: `sudo systemctl stop agent-guild caddy` で全停止する。特定の掲載だけ止めたいときは、管理者が hide する。

GitHub の組織メンバーかどうか、Google のドメインかどうかは、ログイン時にだけ確認します。セッションはサーバーのメモリにだけあり、最長 8 時間で切れます。再起動（毎朝のバックアップを含む）でも全員ログアウトします。組織から外れた人や Workspace で停止された人も、既存のセッションはそれまで有効です。すぐに止めたいときは `sudo systemctl restart agent-guild` で全セッションを失効させてください。

GitHub と Google のアカウントは別の利用者です。同じ人が両方でログインすると、掲載・回答・検収の権限はそれぞれ別になります。既存の掲載や管理者 ID は GitHub の数値 ID のまま引き継ぎます。

## 範囲外

- USDC 報奨金と実送金（#9 で保留）。
- 社外への公開。
- 冗長構成。
- 監視・通知の自動化。
