# entame（エンタメ管理）

エンタメ管理のアプリ本体です（データは入っていません。ログインした本人だけが自分のデータを読み書きできます）。

もとは `apps` リポジトリの中の1フォルダでしたが、2026-11-24 に独立したリポジトリに分けました。

- 機能ごとにファイルを分けている：core.js（決まった値・データ・保存）→ view.js（一覧・番組表）→ filters.js（絞り込み・並び替え）→ detail.js（作品の詳細）→ episodes.js（話数タブ）→ form.js（作品の編集）→ settings.js → yt.js / yt-detail.js（YouTube）→ anilist.js / al-ui.js（AniList連携）→ events.js（ボタン・入力の受け付け）→ boot.js（起動）。見た目は app.css
- ログイン・保存と同期・スワイプなどの共通の土台は core.js、共通の見た目は app.css の先頭に入っている（もとの `shared/` を取り込み済み）

## 公開

main に反映すると、GitHub Actions（`.github/workflows/pages.yml`）が GitHub Pages に公開します。公開の直前に `.github/scripts/stamp.py` が版の番号（日本時間の日時）を自動で付けます。
（リポジトリの Settings → Pages → Source は「GitHub Actions」にしておく）
