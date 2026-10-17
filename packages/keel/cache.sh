# keel's content-addressed build cache for the kernel and the base.
#
# kernel/build.sh and base/build.sh source this file; `cache.sh key` prints
# what a build would be keyed on. The key is the contents of a build's
# inputs, not a commit, so the same tree in another clone, on another branch
# or in a worktree finds the same entry. Entries live in
# $KEEL_CACHE/v1/<kind>/<arch>/<key>/ and are used only when complete and
# intact.
#
# What a build script uses, after `keel_cache_setup <kind> <arch>`, with
# kc_out (its out/ directory) and kc_cache (its .cache/ directory) set in
# the build script, and read here:
#   kc_mode             off (no KEEL_CACHE) | hit | bypass | miss
#   keel_cache_blocked  a bypass or a miss: one line on stderr
#   keel_cache_sources  a miss: .cache filled from $KEEL_CACHE/v1/src first
#   keel_cache_adopt    a miss: .cache's sources checked, then v1/src filled
#   keel_cache_read     a hit: checks, then copies the outputs; prints theirs
#   keel_cache_store    a miss: stores atomically, or compares, then done
#
# Without KEEL_CACHE set, kc_mode is off and every one of them does nothing.
#
# The cache is bypassed, and the build runs exactly as before, when a setting
# or a tree could make the outputs differ from the key: KEEL_REFRESH=1,
# DOCKER_DEFAULT_PLATFORM, no git work tree, changed, untracked or ignored
# files among the inputs, submodules, another mode or stage, or a path git
# would quote. The stderr line is all a bypass adds.

# Where the build script that sources this file lives. A sourced file sees
# the caller's $0, so build.sh and base/build.sh export
# KEEL_CACHE_SCRIPT_DIR with their own directory, packages/keel/kernel or
# packages/keel/base; cache.sh run on its own works its own out.
case "${KEEL_CACHE_SCRIPT_DIR:-}" in
*/kernel | */base) kc_script_dir=$KEEL_CACHE_SCRIPT_DIR kc_up=../../.. ;;
*)
	kc_script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 1
	kc_up=../..
	;;
esac
# Kept here: cache.sh is sourced, and kc_script_dir is a name a subshell could
# otherwise leave different for the caller.
keel_cache_script_dir=$kc_script_dir
keel_cache_up=$kc_up

keel_cache_version=keel-cache-v1
keel_cache_kind=
keel_cache_arch=
keel_cache_mode=off
keel_cache_root=
keel_cache_key=
keel_cache_entry=
keel_cache_reason=
keel_cache_head=none
keel_cache_repo=
keel_cache_manifest=
keel_cache_builder=
keel_cache_builder_version=
keel_cache_compiler=
keel_cache_extra=
keel_cache_source_names=
keel_cache_image_name=keel-builder

# keel_cache_setup <kind> <arch>: works out the mode, the key and the entry.
keel_cache_setup() {
	keel_cache_kind=$1
	keel_cache_arch=$2
	keel_cache_mode=off
	kc_key=
	kc_reason=
	if [ -z "${KEEL_CACHE:-}" ]; then
		return 0
	fi
	case "$keel_cache_kind" in
	kernel | base) ;;
	*)
		echo "keel cache: unknown kind $keel_cache_kind" >&2
		exit 2
		;;
	esac
	if ! keel_cache_abs "$KEEL_CACHE"; then
		echo "keel cache: KEEL_CACHE=$KEEL_CACHE is not an existing directory" >&2
		exit 1
	fi
	keel_cache_root=$kc_abs
	# The cache is shared between work trees, so a build must run the cache.sh
	# of its own tree, and that file must be one of its inputs: an entry keyed
	# on something else could be stored or reused with wrong bytes.
	if ! keel_cache_abs "$kc_script_dir" || [ "$kc_abs" != "$kc_script_dir" ]; then
		echo "keel cache: cache.sh must be the one in the build script's work tree" >&2
		exit 1
	fi
	keel_cache_key
	if [ -z "$kc_key" ]; then
		keel_cache_mode=bypass
		keel_cache_reason=$kc_reason
		return 0
	fi
	if ! keel_cache_image_mode; then
		keel_cache_reason=$kc_reason
		keel_cache_mode=bypass
		return 0
	fi
	keel_cache_key=$kc_key
	keel_cache_entry=$keel_cache_root/v1/$keel_cache_kind/$keel_cache_arch/$kc_key
	if [ -f "$keel_cache_entry/SHA256SUMS" ]; then
		keel_cache_mode=hit
		return 0
	fi
	# Said once per build, from a file: setup runs in a subshell when cache.sh
	# gives the key, and its answer is used here.
	if [ -d "$keel_cache_entry" ] &&
		[ "$(cat "$keel_cache_root/v1/tmp/said-$keel_cache_arch" 2>/dev/null)" != incomplete ]; then
		echo "incomplete keel cache entry $keel_cache_entry, not used" >&2
		printf 'incomplete\n' >"$keel_cache_root/v1/tmp/said-$keel_cache_arch"
	fi
	keel_cache_mode=miss
	return 0
}

# keel_cache_key: sets kc_key and keeps the manifest in kc_manifest, or sets
# kc_reason and no key.
keel_cache_key() {
	kc_key=
	kc_reason=
	kc_manifest=
	if [ "${KEEL_REFRESH:-0}" = 1 ]; then
		kc_reason="KEEL_REFRESH=1"
		return 0
	fi
	if [ -n "${DOCKER_DEFAULT_PLATFORM:-}" ]; then
		kc_reason="DOCKER_DEFAULT_PLATFORM is set"
		return 0
	fi
	case "$(uname -m)" in
	aarch64 | arm64) kc_builder_arch=aarch64 ;;
	x86_64 | amd64) kc_builder_arch=x86_64 ;;
	*)
		kc_reason="no cache key for builder architecture $(uname -m)"
		return 0
		;;
	esac
	# kc_up climbs from the directory named at the top of this file to the
	# repository root: packages/keel/kernel or packages/keel/base for a build
	# script, packages/keel for this file run on its own.
	if ! keel_cache_abs "$keel_cache_script_dir/$keel_cache_up"; then
		kc_reason="not a git work tree"
		return 0
	fi
	keel_cache_repo=$kc_abs
	if ! (cd "$keel_cache_repo" && git rev-parse --is-inside-work-tree) >/dev/null 2>&1; then
		kc_reason="not a git work tree"
		return 0
	fi
	keel_cache_pathspecs
	case " $kc_inputs " in
	*" packages/keel/cache.sh "*) ;;
	*)
		kc_reason="cache.sh is not an input of $keel_cache_kind"
		return 0
		;;
	esac
	# shellcheck disable=SC2086 # the pathspecs are split on purpose
	if ! kc_status=$(git -C "$keel_cache_repo" -c core.quotePath=true status \
		--porcelain --untracked-files=all -- $kc_inputs 2>&1); then
		kc_reason="git status failed"
		return 0
	fi
	if [ -n "$kc_status" ]; then
		kc_reason="inputs changed in the work tree"
		return 0
	fi
	# shellcheck disable=SC2086
	if ! kc_ignored=$(git -C "$keel_cache_repo" ls-files --others --ignored \
		--exclude-standard -- $kc_inputs 2>&1); then
		kc_reason="git ls-files failed"
		return 0
	fi
	# --exclude-standard leaves out an ignored directory that holds only ignored
	# files. out/ is one, and a build reads what may sit there: base/.cache/ holds
	# only what the build downloads itself, so it does not block a rebuild.
	kc_dirs=
	if cd "$keel_cache_repo"; then
		kc_dirs=$(find packages/keel/out -name .git -prune -o -type d -print \
			2>/dev/null) || kc_dirs=
	fi
	# check-ignore exits 1 when nothing under those names is ignored, which is
	# the usual answer, and 128 for no path at all; neither says anything here.
	# shellcheck disable=SC2086
	kc_ignored_dirs=$(if [ -n "$kc_dirs" ]; then
		git -C "$keel_cache_repo" -c core.quotePath=true check-ignore \
			--no-index -- $kc_dirs 2>/dev/null
	fi; true)
	if [ -n "$kc_ignored" ] || [ -n "$kc_ignored_dirs" ]; then
		kc_reason="ignored files among the inputs"
		return 0
	fi
	mkdir -p "$keel_cache_root/v1/tmp" || exit 1
	kc_manifest=$(mktemp "$keel_cache_root/v1/tmp/manifest.XXXXXX") || exit 1
	if ! keel_cache_lines >"$kc_manifest.lines" 2>"$kc_manifest.reason"; then
		kc_reason='an input path or mode the cache will not key on'
		[ ! -s "$kc_manifest.reason" ] || kc_reason=$(cat "$kc_manifest.reason")
		rm -f "$kc_manifest" "$kc_manifest.lines" "$kc_manifest.reason"
		return 0
	fi
	rm -f "$kc_manifest.reason"
	if ! LC_ALL=C sort "$kc_manifest.lines" >"$kc_manifest"; then
		rm -f "$kc_manifest" "$kc_manifest.lines"
		exit 1
	fi
	rm -f "$kc_manifest.lines"
	# Kept for the store: the tree does not change while the container runs.
	keel_cache_manifest=$kc_manifest
	kc_sum=$(shasum -a 256 <"$kc_manifest" | cut -d' ' -f1)
	kc_key=$(printf '%s\n%s\n%s\n%s\n%s\n' "$keel_cache_version" \
		"$keel_cache_kind" "$keel_cache_arch" "$kc_builder_arch" "$kc_sum" |
		shasum -a 256 | cut -d' ' -f1)
}

# keel_cache_pathspecs: kc_inputs, this kind's pathspecs, relative to the root.
keel_cache_pathspecs() {
	case "$keel_cache_kind" in
	kernel)
		kc_inputs="packages/keel/cache.sh packages/keel/kernel/build.sh packages/keel/kernel/build-in-container.sh packages/keel/kernel/defconfig-$keel_cache_arch"
		;;
	base)
		kc_inputs="packages/keel/cache.sh packages/keel/base packages/keel/init packages/keel/agent packages/runner-protocol Cargo.toml Cargo.lock rust-toolchain.toml :(glob)packages/**/Cargo.toml .cargo"
		;;
	esac
}

# keel_cache_lines: the manifest on stdout, unsorted: for each input, its
# mode, the sha256 of the file on disk and its path. git's object is not in
# the key. Prints why a path or a mode cannot be keyed on, and returns 1.
keel_cache_lines() {
	keel_cache_pathspecs
	# shellcheck disable=SC2086
	if ! kc_listing=$(git -C "$keel_cache_repo" -c core.quotePath=true \
		ls-files -s -v -- $kc_inputs); then
		echo "git could not list the inputs"
		return 1
	fi
	keel_cache_each_line() {
		kc_meta=${1%	*}
		kc_path=${1##*	}
		# ls-files -v puts the tag's status letter first, as "H".
		kc_rest=${kc_meta#* }
		kc_mode=${kc_rest%% *}
		kc_rest=${kc_rest#* }
		kc_stage=${kc_rest##* }
		case "$kc_path" in
		'"'*)
			echo "input path $kc_path is quoted by git"
			return 1
			;;
		esac
		case "$kc_mode" in
		100644 | 100755) ;;
		*)
			echo "input $kc_path has mode $kc_mode"
			return 1
			;;
		esac
		if [ "$kc_stage" != 0 ]; then
			echo "input $kc_path is staged at $kc_stage"
			return 1
		fi
		if [ ! -f "$keel_cache_repo/$kc_path" ]; then
			echo "input $kc_path is not a file"
			return 1
		fi
		printf '%s %s %s\n' "$kc_mode" \
			"$(shasum -a 256 <"$keel_cache_repo/$kc_path" | cut -d' ' -f1)" "$kc_path"
	}
	while IFS= read -r kc_line; do
		[ -n "$kc_line" ] || continue
		keel_cache_each_line "$kc_line" || return 1
	done <<EOF
$kc_listing
EOF
}

# keel_cache_abs <path>: sets kc_abs to its absolute, resolved form.
keel_cache_abs() {
	kc_abs=
	case "$1" in
	/*) kc_path=$1 ;;
	*) kc_path=$(pwd -P)/$1 ;;
	esac
	[ -e "$kc_path" ] || return 1
	kc_abs=$(cd "$kc_path" 2>/dev/null && pwd -P) && [ -n "$kc_abs" ]
}

# keel_cache_blocked: the line for a bypass or a miss, on stderr.
keel_cache_blocked() {
	case "$keel_cache_mode" in
	bypass) echo "$keel_cache_arch: keel cache bypassed: $keel_cache_reason" >&2 ;;
	miss) echo "$keel_cache_arch: keel cache miss $keel_cache_key" >&2 ;;
	esac
	return 0
}

# keel_cache_files: kc_files, everything an entry holds, and kc_outputs, the
# *.sha256 files among them.
keel_cache_files() {
	case "$keel_cache_kind" in
	kernel)
		kc_files="SHA256SUMS inputs.txt provenance.txt vmlinuz config vmlinuz.sha256"
		kc_outputs="vmlinuz.sha256"
		;;
	base)
		kc_files="SHA256SUMS inputs.txt provenance.txt base.erofs base.erofs.sha256 base-standin.erofs base-standin.erofs.sha256 base.txt"
		kc_outputs="base.erofs.sha256 base-standin.erofs.sha256"
		;;
	esac
}

# keel_cache_verify: the entry's file set is exactly kc_files, every hash in
# SHA256SUMS matches its file, and each *.sha256 matches its image. Exits 1
# on any deviation, naming the file to remove.
keel_cache_verify() {
	kc_listing=$(
		for kc_file in "$keel_cache_entry"/*; do
			if [ -e "$kc_file" ]; then
				printf '%s\n' "${kc_file##*/}"
			fi
		done
	)
	# shellcheck disable=SC2086 # one name per line
	kc_want=$(printf '%s\n' $kc_files | LC_ALL=C sort)
	if [ "$kc_listing" != "$kc_want" ]; then
		keel_cache_corrupt "$keel_cache_entry"
	fi
	for kc_file in $kc_files; do
		[ "$kc_file" = SHA256SUMS ] && continue
		kc_hash=$(keel_cache_hash "$kc_file")
		if [ -z "$kc_hash" ] || [ "$(shasum -a 256 <"$keel_cache_entry/$kc_file" |
			cut -d' ' -f1)" != "$kc_hash" ]; then
			keel_cache_corrupt "$keel_cache_entry/$kc_file"
		fi
	done
	for kc_file in $kc_outputs; do
		kc_hash=$(shasum -a 256 <"$keel_cache_entry/${kc_file%.sha256}" | cut -d' ' -f1)
		if [ "$kc_hash" != "$(cat "$keel_cache_entry/$kc_file")" ]; then
			keel_cache_corrupt "$keel_cache_entry/$kc_file"
		fi
	done
	return 0
}

# keel_cache_hash <name>: the hash on name's line of the entry's SHA256SUMS,
# or nothing.
keel_cache_hash() {
	kc_line=$(grep -E "^[0-9a-f]{64}  $1\$" "$keel_cache_entry/SHA256SUMS") ||
		kc_line=
	echo "${kc_line%% *}"
}

# keel_cache_corrupt <what>: names the path to remove, and stops the build.
keel_cache_corrupt() {
	echo "keel cache entry corrupt: $1; remove it" >&2
	exit 1
}

# keel_cache_read: a hit. Verifies the entry, copies its outputs into
# out/<arch> through temporary names, verifies the copies, and leaves the
# outputs' hashes in kc_hashes for the build script's line. A work tree that
# already holds the verified files copies nothing.
keel_cache_read() {
	keel_cache_files
	keel_cache_verify
	mkdir -p "$kc_out/$keel_cache_arch" || exit 1
	kc_hashes=
	for kc_file in vmlinuz config vmlinuz.sha256 base.erofs base.erofs.sha256 \
		base-standin.erofs base-standin.erofs.sha256 base.txt; do
		case " $kc_files " in
		*" $kc_file "*) ;;
		*) continue ;;
		esac
		kc_hash=$(keel_cache_hash "$kc_file")
		kc_copy=$kc_out/$keel_cache_arch/$kc_file
		if [ ! -f "$kc_copy" ] || [ "$(shasum -a 256 <"$kc_copy" |
			cut -d' ' -f1)" != "$kc_hash" ]; then
			kc_tmp=$kc_copy.cache.$$
			if ! cp "$keel_cache_entry/$kc_file" "$kc_tmp"; then
				rm -f "$kc_tmp"
				keel_cache_corrupt "$keel_cache_entry/$kc_file"
			fi
			mv "$kc_tmp" "$kc_copy"
			if [ "$(shasum -a 256 <"$kc_copy" | cut -d' ' -f1)" != "$kc_hash" ]; then
				keel_cache_corrupt "$kc_copy"
			fi
		fi
	done
	keel_cache_files
	kc_hashes=
	for kc_file in $kc_outputs; do
		kc_hash=$(shasum -a 256 <"$kc_out/$keel_cache_arch/${kc_file%.sha256}" |
			cut -d' ' -f1)
		if [ "$kc_hash" != "$(cat "$kc_out/$keel_cache_arch/$kc_file")" ]; then
			keel_cache_corrupt "$kc_out/$keel_cache_arch/$kc_file"
		fi
		kc_hashes="$kc_hashes$kc_hash "
	done
	kc_hashes=${kc_hashes% }
	return 0
}

# keel_cache_fetch_image <name> <url>: a miss, one source file. It comes from
# $KEEL_CACHE/v1/src if it is there; otherwise it is fetched into
# .cache/<name>.part.$$, moves into .cache, and joins v1/src through its own
# .part.$$, so no container mount ever holds half a file. The build's own
# sha256 check is unchanged and still runs on the result.
# shellcheck disable=SC2154 # kc_cache and kc_out come from the build script
keel_cache_fetch_image() {
	if [ -f "$keel_cache_root/v1/src/$1" ]; then
		if ! cp "$keel_cache_root/v1/src/$1" "$kc_cache/$1.part.$$" ||
			! mv "$kc_cache/$1.part.$$" "$kc_cache/$1"; then
			exit 1
		fi
		return 0
	fi
	keel_cache_fetch "$1" "$2"
}

# keel_cache_fetch <name> <url>: a miss, a download straight into v1/src.
keel_cache_fetch() {
	mkdir -p "$keel_cache_root/v1/src" || exit 1
	curl -fL --proto '=https' -o "$keel_cache_root/v1/src/$1.part.$$" "$2" || {
		rm -f "$keel_cache_root/v1/src/$1.part.$$"
		exit 1
	}
	if ! mv "$keel_cache_root/v1/src/$1.part.$$" "$keel_cache_root/v1/src/$1" ||
		! cp "$keel_cache_root/v1/src/$1" "$kc_cache/$1.part.$$" ||
		! mv "$kc_cache/$1.part.$$" "$kc_cache/$1"; then
		exit 1
	fi
	return 0
}

# keel_cache_sources: a miss. Copies the pinned sources of this build from
# $KEEL_CACHE/v1/src into the clone's .cache first, so that the download loop
# finds them and checks their hashes as it always did, once per build. $1 is
# the names.
keel_cache_sources() {
	keel_cache_source_names=$1
	# The clone's own .cache, which the build has always created; never the
	# cache's v1/src, which only a download creates.
	mkdir -p "$kc_cache" || exit 1
	for kc_name in $keel_cache_source_names; do
		if [ -f "$keel_cache_root/v1/src/$kc_name" ] && [ ! -f "$kc_cache/$kc_name" ]; then
			cp "$keel_cache_root/v1/src/$kc_name" "$kc_cache/$kc_name" || exit 1
		fi
	done
	return 0
}

# keel_cache_adopt: a miss, after the sources' hashes were checked, the
# download loop has run. A file the loop fetched joins v1/src; a file that is
# missing or differs there is replaced by this clone's, through .part.$$.
# The names are the build's sources and the ones v1/src has, so a file another
# build fetched for another architecture is checked here too.
keel_cache_adopt() {
	kc_names=$keel_cache_source_names
	for kc_path in "$keel_cache_root"/v1/src/*; do
		if [ -f "$kc_path" ]; then
			kc_names="$kc_names ${kc_path##*/}"
		fi
	done
	for kc_name in $kc_names; do
		[ -f "$kc_cache/$kc_name" ] || continue
		if ! cmp -s "$kc_cache/$kc_name" "$keel_cache_root/v1/src/$kc_name"; then
			if ! cp "$kc_cache/$kc_name" "$keel_cache_root/v1/src/$kc_name.part.$$" ||
				! mv "$keel_cache_root/v1/src/$kc_name.part.$$" \
					"$keel_cache_root/v1/src/$kc_name"; then
				exit 1
			fi
		fi
	done
	return 0
}

# keel_cache_store: a miss, after a successful build. Writes the entry in a
# staging directory on the same filesystem, takes it with mkdir, which is
# atomic, and moves the files in with SHA256SUMS last. If another build took
# it first, compares only the outputs' hashes: the other files may differ in
# time, HEAD and toolchain. A difference is a warning, and nothing is
# overwritten. $1 is what the build says about its compiler.
keel_cache_store() {
	keel_cache_compiler=$1
	keel_cache_files
	mkdir -p "$keel_cache_root/v1/tmp" \
		"$keel_cache_root/v1/$keel_cache_kind/$keel_cache_arch" || exit 1
	kc_staging=$(mktemp -d "$keel_cache_root/v1/tmp/XXXXXX") || exit 1
	{
		echo "key $keel_cache_key"
		echo "kind $keel_cache_kind"
		echo "arch $keel_cache_arch"
		echo "head $keel_cache_head"
		echo "builder-arch $(uname -m)"
		echo "uname $(uname -sm)"
		echo "builder $keel_cache_builder"
		echo "version $keel_cache_builder_version"
		echo "compiler $keel_cache_compiler"
		for kc_line in $keel_cache_extra; do
			echo "$kc_line"
		done
		echo "built $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
	} >"$kc_staging/provenance.txt" || exit 1
	# mktemp makes the manifest 0600; an entry is read by any build of the
	# reader's own account, and SHA256SUMS must not depend on the umask.
	if ! cp "$keel_cache_manifest" "$kc_staging/inputs.txt" ||
		! chmod 644 "$kc_staging/inputs.txt" "$kc_staging/provenance.txt"; then
		rm -rf "$kc_staging"
		exit 1
	fi
	for kc_file in $kc_files; do
		case "$kc_file" in
		SHA256SUMS | inputs.txt | provenance.txt) continue ;;
		esac
		if ! cp "$kc_out/$keel_cache_arch/$kc_file" "$kc_staging/$kc_file"; then
			rm -rf "$kc_staging"
			exit 1
		fi
	done
	if ! (cd "$kc_staging" && : >SHA256SUMS.$$ && \
		for kc_file in SHA256SUMS inputs.txt provenance.txt vmlinuz config \
			vmlinuz.sha256 base.erofs base.erofs.sha256 base-standin.erofs \
			base-standin.erofs.sha256 base.txt; do
			[ -f "$kc_file" ] || continue
			[ "$kc_file" = SHA256SUMS ] && continue
			shasum -a 256 "$kc_file" >>SHA256SUMS.$$
		done &&
		LC_ALL=C sort SHA256SUMS.$$ >SHA256SUMS && rm -f SHA256SUMS.$$); then
		rm -rf "$kc_staging"
		exit 1
	fi
	if mkdir "$keel_cache_entry" 2>/dev/null; then
		for kc_file in $kc_files; do
			[ "$kc_file" = SHA256SUMS ] && continue
			if ! mv "$kc_staging/$kc_file" "$keel_cache_entry/$kc_file"; then
				rm -rf "$kc_staging"
				exit 1
			fi
		done
		if ! mv "$kc_staging/SHA256SUMS" "$keel_cache_entry/SHA256SUMS"; then
			rm -rf "$kc_staging"
			exit 1
		fi
		rmdir "$kc_staging"
		echo "$keel_cache_arch: keel cache stored $keel_cache_key"
		return 0
	fi
	rm -rf "$kc_staging"
	keel_cache_compare
	return 0
}

# keel_cache_compare: another build of this key stored the entry first. It is
# still being written while SHA256SUMS is missing, for up to a minute; a build
# that stores in a second is as much as one host ever needs, and waiting an
# hour would hide a stuck build behind a passed store.
keel_cache_compare() {
	keel_cache_files
	kc_waited=0
	while [ ! -f "$keel_cache_entry/SHA256SUMS" ]; do
		if [ "$kc_waited" -ge 60 ]; then
			echo "warning: keel cache entry $keel_cache_entry never completed" >&2
			return 0
		fi
		sleep 1
		kc_waited=$((kc_waited + 1))
	done
	for kc_file in $kc_outputs; do
		kc_mine=$(shasum -a 256 <"$kc_out/$keel_cache_arch/${kc_file%.sha256}" |
			cut -d' ' -f1)
		kc_theirs=$(keel_cache_hash "${kc_file%.sha256}")
		if [ "$kc_mine" != "$kc_theirs" ] ||
			[ "$kc_theirs" != "$(cat "$keel_cache_entry/$kc_file")" ]; then
			echo "warning: keel build not reproducible against cache $keel_cache_entry" >&2
			return 0
		fi
	done
	echo "$keel_cache_arch: keel cache kept $keel_cache_key from an earlier build"
	return 0
}

# keel_cache_archs <script>: the architectures a build script builds when it
# is given none, from its own `set --` line.
keel_cache_archs() {
	kc_archs=
	# shellcheck disable=SC2016 # the line is the script's, not this one's
	# shellcheck disable=SC2013,SC2046,SC2086 # the words of its own set --
	for kc_word in $(grep -E '^[[:space:]]*\[ "\$#" -gt 0 \] \|\| set -- ' "$1" |
		sed -e 's/^[^|]*|*//' -e 's/set//' -e 's/--//'); do
		case "$kc_word" in
		arm64 | x86_64) kc_archs="$kc_archs $kc_word" ;;
		esac
	done
	echo "${kc_archs# }"
}

# keel_cache_outdir <script>: the directory a build script writes to.
keel_cache_outdir() {
	kc_outdir=$(sed -n 's/^kc_out=//p' "$1" | sed -e 's/^"//' -e 's/"$//')
	echo "${kc_outdir:-$(dirname "$1")/../out}"
}

keel_cache_error() {
	echo "keel cache: $*" >&2
	exit 1
}

# The command line. `cache.sh key` prints the keys a build would use, or why
# it would bypass; the build scripts run cache.sh with --keel-cache-key.
keel_cache_cli() {
	case "${1:-}" in
	--keel-cache-key) shift && keel_cache_cli_key "$@" ;;
	key) shift && keel_cache_cli_key "$@" ;;
	*) keel_cache_error "usage: cache.sh key <kernel|base> [arm64|x86_64 ...]" ;;
	esac
}

keel_cache_cli_key() {
	[ "$#" -gt 0 ] || keel_cache_error "usage: cache.sh key <kernel|base> [arch ...]"
	keel_cache_kind=$1
	shift
	case "$keel_cache_kind" in
	kernel | base) ;;
	*) keel_cache_error "usage: cache.sh key <kernel|base> [arch ...]" ;;
	esac
	# The build script of this kind, beside this file: cache.sh run on its own
	# is the one in packages/keel, next to the kernel/ and base/ directories.
	keel_cache_abs "$(dirname "$0")" || keel_cache_error "no $(dirname "$0")"
	kc_script=$kc_abs/$keel_cache_kind/build.sh
	[ -f "$kc_script" ] || keel_cache_error "no $kc_script"
	[ -n "${KEEL_CACHE:-}" ] || keel_cache_error "KEEL_CACHE is not set"
	if [ "$#" -eq 0 ]; then
		# shellcheck disable=SC2046 # the architectures, one per word
		set -- $(keel_cache_archs "$kc_script")
	fi
	for kc_arch in "$@"; do
		case "$kc_arch" in
		arm64 | x86_64) ;;
		*) keel_cache_error "unknown architecture $kc_arch" ;;
		esac
	done
	# What a full build records in provenance.txt comes from the script; a key
	# does not depend on it, because it would need a download.
	keel_cache_builder=$(sed -n 's/^builder=//p' "$kc_script")
	keel_cache_builder_version=$(sed -n 's/^version=//p' "$kc_script")
	keel_cache_extra=$(sed -n -e 's/^rustup_\([a-z0-9_]*\)=/rustup \1 /p' \
		-e "s/^\(lz4\|e2fsprogs\|erofs-utils\)-\([^ ]*\) \([^ ]*\) \([0-9a-f]*\)$/source \1 \2 \3 \4/p" "$kc_script")
	for kc_arch in "$@"; do
		kc_out=$(keel_cache_outdir "$kc_script")
		keel_cache_setup "$keel_cache_kind" "$kc_arch"
		case "$keel_cache_mode" in
		bypass)
			echo "bypass: $keel_cache_reason"
			# The key cannot be represented; nothing to print. Non-zero, as
			# the build scripts read a bypass line as "no key".
			exit 1
			;;
		*) printf '%s %s %s\n' "$keel_cache_kind" "$kc_arch" "$keel_cache_key" ;;
		esac
	done
	return 0
}

# keel_cache_image_mode: the builder image, which the build scripts set in
# keel_cache_builder before they download anything, must be the digest-pinned
# one the first build of this cache recorded in v1/src/keel-builder. An image
# that is not digest-pinned would make the outputs drift under an unchanged
# key, and no other build would notice.
keel_cache_image_mode() {
	keel_cache_image=$keel_cache_root/v1/src/$keel_cache_image_name
	[ -n "$keel_cache_builder" ] || return 0
	mkdir -p "$keel_cache_root/v1/src" || exit 1
	if [ ! -f "$keel_cache_image" ]; then
		printf '%s\n' "$keel_cache_builder" >"$keel_cache_image.part.$$" &&
			mv "$keel_cache_image.part.$$" "$keel_cache_image" || exit 1
		return 0
	fi
	keel_cache_first=$(sed -n '1p' "$keel_cache_image") || keel_cache_first=
	if [ "$keel_cache_first" = "$keel_cache_builder" ]; then
		return 0
	fi
	# Extra lines on purpose: a build reads only the first of them.
	echo "keel cache: this build asks for builder $keel_cache_builder" >&2
	echo "keel cache: $keel_cache_image was recorded with $keel_cache_first" >&2
	echo "keel cache: use another KEEL_CACHE, or remove $keel_cache_root if it is yours" >&2
	return 1
}

# Sourced by the build scripts, which return from their own file first; the
# only way to reach this is running cache.sh itself or its --keel-cache-key.
case "${1:-}" in
key | --keel-cache-key) keel_cache_cli "$@" ;;
esac
