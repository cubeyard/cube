# Test only: a thread's web server for the portal over a protocol-4 `dial`
# (portal-dial.ts: runner-dial-test.ts offline, runner-vm-test.ts V9 in a
# keel machine), run with `cube service start`. Perl, as keel's images have
# it with git. One process per connection:
#   GET /             200 and a known body
#   POST /echo        the request body back (Content-Length)
#   GET /ws           a WebSocket (RFC 6455) that echoes each message
#   GET /fin-client   (Upgrade) reads to the client's FIN, then answers
#                     "got N SHA256" and closes
#   GET /fin-guest?ID (Upgrade) sends "guest-first", closes its sending side
#                     at once, reads to the client's FIN and writes "N SHA256"
#                     to $CUBE_APP_STATE/fin-ID
use strict;
use warnings;
use IO::Socket::INET;
use Digest::SHA qw(sha1 sha256_hex);
use MIME::Base64 qw(encode_base64);

$| = 1;
$SIG{PIPE} = "IGNORE";
$SIG{CHLD} = "IGNORE";
my $server = IO::Socket::INET->new(LocalAddr => "$ENV{HOST}:$ENV{PORT}", Listen => 64, ReuseAddr => 1) or die "listen: $!\n";
print "listening on $ENV{PORT} as $ENV{CUBE_SERVICE}\n";

sub read_exact {
  my ($c, $n, $data) = @_;
  while (length($data) < $n) {
    my $got = sysread($c, my $chunk, $n - length($data));
    return undef unless $got;
    $data .= $chunk;
  }
  return $data;
}

sub drain {
  my ($c, $data) = @_;
  while (sysread($c, my $chunk, 65536)) { $data .= $chunk }
  return length($data) . " " . sha256_hex($data);
}

sub websocket {
  my ($c, $data) = @_;
  for (;;) {
    my $head = read_exact($c, 2, substr($data, 0, 2, "")) // return;
    my ($b0, $b1) = unpack("CC", $head);
    my $length = $b1 & 127;
    $length = unpack("n", read_exact($c, 2, substr($data, 0, 2, "")) // return) if $length == 126;
    $length = unpack("Q>", read_exact($c, 8, substr($data, 0, 8, "")) // return) if $length == 127;
    my $mask = read_exact($c, 4, substr($data, 0, 4, "")) // return;
    my $payload = read_exact($c, $length, substr($data, 0, $length, "")) // return;
    $payload ^= substr($mask x (int($length / 4) + 1), 0, $length);
    my $opcode = $b0 & 15;
    if ($opcode == 8) { syswrite($c, pack("CC", 0x88, 0)); return }
    my $frame = pack("C", 0x80 | $opcode);
    $frame .= $length < 126 ? pack("C", $length) : $length < 65536 ? pack("Cn", 126, $length) : pack("CQ>", 127, $length);
    syswrite($c, $frame . $payload);
  }
}

sub serve {
  my ($c) = @_;
  my $data = "";
  while (index($data, "\r\n\r\n") < 0) {
    sysread($c, my $chunk, 65536) or return;
    $data .= $chunk;
  }
  my ($head, $rest) = split(/\r\n\r\n/, $data, 2);
  my ($method, $target) = $head =~ /^(\S+) (\S+)/;
  my %headers = map { /^([^:]+):\s*(.*)$/ ? (lc $1 => $2) : () } split(/\r\n/, $head);
  if ($target eq "/") {
    my $body = "dial-app: hello from $ENV{CUBE_SERVICE}\n";
    syswrite($c, "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: " . length($body) . "\r\n\r\n$body");
  } elsif ($method eq "POST" && $target eq "/echo") {
    my $body = read_exact($c, $headers{"content-length"}, $rest) // return;
    syswrite($c, "HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ncontent-length: " . length($body) . "\r\n\r\n");
    for (my $at = 0; $at < length($body); $at += 65536) { syswrite($c, substr($body, $at, 65536)) }
  } elsif ($target eq "/ws") {
    my $accept = encode_base64(sha1($headers{"sec-websocket-key"} . "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"), "");
    syswrite($c, "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: $accept\r\n\r\n");
    websocket($c, $rest);
  } elsif ($target eq "/fin-client") {
    syswrite($c, "HTTP/1.1 101 Switching Protocols\r\nupgrade: cube-test\r\nconnection: Upgrade\r\n\r\n");
    syswrite($c, "got " . drain($c, $rest) . "\n");
  } elsif ($target =~ m{^/fin-guest\?([a-z0-9]+)$}) {
    my $id = $1;
    syswrite($c, "HTTP/1.1 101 Switching Protocols\r\nupgrade: cube-test\r\nconnection: Upgrade\r\n\r\nguest-first\n");
    shutdown($c, 1);
    my $got = drain($c, $rest);
    open(my $out, ">", "$ENV{CUBE_APP_STATE}/fin-$id.tmp") or die;
    print $out "$got\n";
    close($out);
    rename("$ENV{CUBE_APP_STATE}/fin-$id.tmp", "$ENV{CUBE_APP_STATE}/fin-$id");
  } else {
    syswrite($c, "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
  }
}

while (my $c = $server->accept) {
  my $pid = fork();
  if (defined $pid && $pid == 0) { close($server); serve($c); close($c); exit 0 }
  close($c);
}
