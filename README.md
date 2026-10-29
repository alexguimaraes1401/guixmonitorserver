# Gateway JT808/JT1078 com publicação RTSP para OBS

Servidor para receber sinalização JT808 e mídia JT1078 da câmera A3-LA. Após
login, o gateway consulta as capacidades AV e solicita automaticamente os
canais 1 e 2. Os dois vídeos são publicados em caminhos RTSP independentes e
sem áudio; o áudio AAC do canal 1 é publicado uma única vez em um terceiro
caminho compartilhado para uso no OBS ou VLC.

O gateway remonta os subpacotes JT1078, copia o vídeo H.265/H.264 e recodifica
o áudio AAC do canal 1 para o formato aceito pelo muxer RTSP. Processos FFmpeg
independentes publicam os vídeos dos canais 1 e 2 e o áudio compartilhado; o
canal 2 não publica áudio. Uma lacuna ou falha no publicador de áudio não encerra
o publicador de vídeo. Uma falha ou queda de mídia é registrada e o pedido JT808 do canal é reenviado automaticamente enquanto
sua intenção de transmissão estiver ativa. Se a fila de vídeo acumular atraso,
quadros pendentes são descartados somente até um quadro-chave, evitando manter
uma sequência preditiva incompleta; isso pode causar pausas na imagem
proporcionais ao atraso acumulado e ao intervalo entre quadros-chave.
Por padrão, `RTSP_SYNC_MODE=bounded-sync` sincroniza os vídeos dos canais 1 e 2
e o áudio compartilhado do canal 1 usando timestamps JT1078 numa linha do
tempo comum. `RTSP_JITTER_BUFFER_MS` está configurado em 250 ms neste ambiente.
Se uma faixa faltar, ficar atrasada ou exceder `RTSP_SYNC_TOLERANCE_MS`
(250 ms), o gateway tenta alinhar as três saídas por até
`RTSP_SYNC_HOLD_TIMEOUT_MS` (250 ms). Ao atingir esse limite, libera as saídas
em estado degradado, mantendo o relógio comum e tentando realinhar quando as
faixas voltarem à tolerância. Depois de uma espera, o vídeo retoma no próximo
quadro-chave. Se esse quadro estiver atrasado, a linha do tempo comum é
recentralizada para evitar acumular atraso indefinidamente.
`RTSP_SYNC_MAX_SCHEDULE_AHEAD_MS` permite até 750 ms de avanço comum do
agendamento além do buffer de jitter; isso não aumenta a tolerância de
dessincronização entre as faixas, que permanece em 250 ms.
Timestamps inválidos usam a chegada local no modo `bounded-sync`; os modos
sincronizados continuam usando timestamps de origem válidos sempre que
disponíveis. `strict-arrival` mantém a espera sem limite; `best-effort` usa
relógios independentes, sem garantia de alinhamento entre faixas. `syncStatus`
expõe o estado, o tempo em espera, a contagem de liberações degradadas,
`sourceTimestampSkewMs` e os dados de alinhamento da linha do tempo.
O timestamp JT1078 demonstra uma base de tempo comum durante períodos
estáveis, mas não prova o instante físico de captura do sensor.
`RTSP_SYNC_MODE=best-effort` restaura a calibração JT1078 por canal e permite
que os fluxos continuem independentes quando outro falhar; nessa opção, não há
garantia de alinhamento estrito entre capturas.
Os timestamps JT1078 usam milissegundos por padrão, sem inferir a escala pela
velocidade de chegada na rede. Unidades não padronizadas exigem configurar
`RTSP_TIMESTAMP_SCALE_MS_PER_UNIT` explicitamente.
No modo estrito, o gateway também mede a taxa do relógio em janelas de 5 s.
Só ajusta a escala comum compartilhada quando pelo menos duas faixas ativas
concordam dentro de 8% em duas janelas consecutivas, preservando os tempos já
mapeados. Essa confirmação evita que rajadas ou atrasos temporários de rede
sejam confundidos com deriva do relógio e façam quadros serem agendados muito
à frente. A taxa estimada é uma correção de deriva, não uma confirmação do
instante físico de captura.
O monitor de timestamps é automático: `terminals[].timestampMonitor` no
endpoint `/api/status` mantém uma amostra a cada 5 segundos, com os valores
brutos de 64 bits como texto decimal para vídeo do canal 1, vídeo do canal 2 e
áudio do canal 1. Cada amostra inclui hora de chegada, idade, deltas e uma
estimativa de unidades por segundo. O evento
`rtsp-media-source-timestamp-monitor` registra a primeira amostra completa e
depois uma por minuto, sem gerar um log por quadro. O histórico em memória é
limitado a 720 amostras (cerca de uma hora) e é apagado ao reiniciar o serviço;
os eventos emitidos também vão para o log do container.
No modo `best-effort`, timestamps JT1078 insuficientes fazem cada canal usar
uma base de chegada e intervalos de mídia: vídeo usa o intervalo informado
pela câmera (5 a 1000 ms), depois o último intervalo válido, ou 40 ms se ambos
faltarem; AAC usa a duração ADTS. Timestamps ausentes, repetidos, regressivos
ou saltos superiores a 10 segundos são registrados como
`rtsp-media-source-timestamp-invalid`.
O buffer não reduz a resolução nem recodifica o vídeo. O início da publicação
pode levar aproximadamente o tempo configurado no buffer, além da espera por
um quadro-chave; no modo `bounded-sync`, a presença simultânea dos três sinais
é necessária apenas para manter o estado `aligned`. Ajuste
`RTSP_JITTER_BUFFER_MS` (0 a 8000) conforme o equilíbrio desejado entre
fluidez e latência. A tolerância de sincronização continua independente do
buffer; no modo `bounded-sync`, atrasos acima dela colocam as três saídas em
espera somente até `RTSP_SYNC_HOLD_TIMEOUT_MS`. Perda persistente de cobertura
ou banda não é corrigida pelo buffer.

Por padrão, `RTSP_TIMESTAMP_MODE=transport` envia vídeo e AAC ao FFmpeg em
MPEG-TS com timestamps explícitos de 90 kHz e uma origem comum por terminal.
O vídeo usa o instante agendado pelo gateway, antes de bloqueios dos pipes;
o áudio avança pela duração real dos quadros ADTS (amostras/taxa), preservando
lacunas superiores a 250 ms. O FFmpeg mantém esses timestamps com `-copyts`,
sem recriá-los pelo horário de leitura de cada pipe nem zerar cada entrada
separadamente. Vídeo repetido/regressivo é corrigido e registrado no evento
`rtsp-media-timestamp-correction`; `mediaClock` no status expõe os contadores
e os últimos timestamps. O campo `mediaClock.syncClockScope` informa
`terminal-bounded-source-transport` no modo `bounded-sync`,
`terminal-strict-source-transport` no modo `strict-arrival`, ambos baseados na
linha do tempo JT1078 comum, e `terminal-shared-transport` no modo
independente. A origem é
mantida durante a vida do processo e reiniciada quando o serviço é reiniciado.
O transporte usa PTS igual a DTS para fluxos sem reordenação. Nos modos
sincronizados, quadros B (`dataType=2`) suspendem o fluxo afetado porque o
tratamento de reordenação atual não mantém um relógio de transporte comum. No
modo `best-effort`, o gateway preserva o comportamento anterior: reinicia
apenas esse publicador em `wallclock`.
Esta correção não recupera quadros perdidos nem corrige atrasos de captura
reais da câmera. Para retornar ao comportamento anterior, use
`RTSP_SYNC_MODE=best-effort` (e, se necessário,
`RTSP_TIMESTAMP_MODE=wallclock`) e recrie somente o serviço `jt808`.

O canal 1 e o canal 2 solicitam por padrão o fluxo principal da câmera. O áudio
compartilhado vem do canal 1. Isso aumenta o uso de banda móvel. Para reduzir
resolução e bitrate no canal 1, defina `JT1078_CHANNEL_1_STREAM_TYPE=1`; combine
com `JT1078_CHANNEL_1_FORCE_AUDIO=true` para solicitar áudio mesmo no subfluxo.
O modelo A3-LA usado neste ambiente nem sempre envia áudio no subfluxo, então
essa opção é experimental; a configuração mais confiável para áudio é o fluxo
principal (`0`). Para reduzir o canal 2, defina
`JT1078_CHANNEL_2_STREAM_TYPE=1`.

## Inicialização

Requer Docker Desktop com Docker Compose:

```powershell
.\start.cmd
docker compose ps
docker compose logs -f jt808
```

`start.cmd` constrói a imagem `jt808` com o código local e sobe os serviços.
Use-o na primeira inicialização e sempre após alterar o código. Para apenas
reiniciar o container sem reconstruí-lo, use `docker compose restart jt808`;
para iniciar um container parado, use `docker compose start jt808`. O serviço
`jt808` tem a política `unless-stopped`, então reinícios do Docker Desktop ou do
computador reutilizam a última imagem construída e implantada. Um restart não
incorpora alterações ainda não construídas. As opções de operação ficam no
`.env` do projeto e são reaplicadas pelo Compose ao criar o container.

O painel fica em `http://localhost:18081` neste PC e em
`http://IP_DO_PC:18081` na rede. Ele mostra a conexão JT808, o
estado da mídia e os três endereços RTSP. Os estados são mantidos em memória e
desaparecem quando o container é reiniciado; a câmera precisa reconectar para
que o gateway solicite novamente os canais.

Portas publicadas:

| Uso | Transporte | Porta no PC | Porta no container |
| --- | --- | ---: | ---: |
| JT808 | TCP | 6608 | 7611 |
| Receptor de mídia JT1078 | TCP | 1078 | 1078 |
| Dashboard | TCP | 18081 (padrão) | 8080 |
| RTSP para OBS/VLC neste PC | TCP | 8554 | 8554 |
| Saida OBS para MediaMTX (somente neste PC) | TCP | 1935 | 1935 |
| Video HLS para TV na rede local | TCP | 8888 | 8888 |

O RTSP usa TCP intercalado e fica vinculado ao loopback do computador. O OBS
deve rodar nesse mesmo PC; não encaminhe a porta 8554 pelo roteador. Encaminhe
as portas JT808 e JT1078 necessárias à conexão da câmera.

O dashboard é publicado em todas as interfaces (`DASHBOARD_BIND_IP=0.0.0.0`).
Para acesso externo, permita TCP 18081 no Firewall do Windows e encaminhe
TCP 18081 no roteador para o IP local deste PC na porta 18081. O acesso pela
internet depende de um IP público acessível; CGNAT pode impedir esse acesso.
**O dashboard não tem autenticação e permite controlar o OBS e os vídeos da
câmera.** Publicá-lo na internet permite esse controle a qualquer pessoa que
alcance a porta; prefira VPN ou restrição a IPs autorizados. Para limitar o
dashboard novamente a este PC, defina `DASHBOARD_BIND_IP=127.0.0.1` e recrie
o serviço com `docker compose up -d jt808`.

## Conexão da câmera

1. Confirme que o IP público do roteador continua sendo `201.66.73.13`. Se
   mudou, defina o atual ao iniciar o Compose:

   ```powershell
   $env:JT1078_PUBLIC_IP = "IP_PUBLICO_ATUAL"
   docker compose up --build -d
   ```

2. Encaminhe TCP 6608 para o IP local do computador na porta 6608 e TCP 1078
   para o mesmo computador na porta 1078. A configuração documentada usa
   `192.168.1.2`.
3. Configure a câmera para conectar ao IP público nas portas JT808 6608 e
   JT1078 1078. Se necessário, permita TCP 1078 no Firewall do Windows.
4. Quando a câmera fizer login JT808, o gateway consulta as capacidades e
   solicita os canais 1 e 2 automaticamente. Não é preciso iniciar um player
   nem apertar botões no painel.

## Endereços RTSP no OBS

Para o terminal `001208005318`, adicione fontes **Media** e desmarque
**Local File**:

```text
rtsp://127.0.0.1:8554/terminal-001208005318-channel-1
rtsp://127.0.0.1:8554/terminal-001208005318-channel-2
rtsp://127.0.0.1:8554/terminal-001208005318-audio
```

Os dois primeiros caminhos são vídeo-only; o terceiro contém o áudio do canal
1. Use uma única fonte de áudio compartilhada nas cenas desejadas: canal 1 =
vídeo 1 + áudio; canal 2 = vídeo 2; cena composta = vídeos 1 e 2 + uma
única instância do áudio. Assim, o som não é duplicado na cena composta.
Os endereços permanecem os mesmos enquanto esse terminal for usado. Aguarde os
estados de vídeo e áudio mudarem para **Transmitindo** no painel; se aparecer
**Aguardando mídia**, confira a conexão JT1078 e os logs do serviço.

## Assistir a saida do OBS no navegador da TV

O MediaMTX oferece sua propria pagina de reproducao em
`http://IP_DO_PC:8888/obs/`. Ela mostra a cena final publicada pelo OBS,
com audio, nao o dashboard da porta 18081. Nao requer mudar o gateway nem
instalar outro player. O modo HLS MPEG-TS prioriza compatibilidade com TVs,
com alguns segundos de atraso; o suporte depende do navegador da TV.

No OBS deste mesmo PC, abra **Configuracoes > Transmissao**:

- Servico: **Personalizado**;
- Servidor: `rtmp://127.0.0.1:1935`;
- Chave de transmissao: `obs`;
- Sem autenticacao para esse destino local.

Em **Configuracoes > Saida**, use video **H.264** e audio **AAC**, com
intervalo de quadro-chave de **1 ou 2 segundos**, para compatibilidade HLS.
Depois clique em **Iniciar transmissao**. Isso muda o destino de transmissao
do OBS: se ele estiver publicando para outra plataforma, nao substitua esse
destino sem antes preparar uma segunda saida. O servidor nao inicia o OBS
nem altera essas configuracoes automaticamente.

Na TV, abra a pagina e clique em reproduzir/ativar som e tela cheia.
O navegador pode bloquear reproducao automatica com audio. Antes de o OBS
publicar, a pagina abre mas nao existe video para reproduzir.
O endereco direto da playlist e `http://IP_DO_PC:8888/obs/index.m3u8`.

`HLS_BIND_IP` define o IP local do PC; o padrao do Compose e `127.0.0.1`
(somente local). Neste ambiente, `.env` define `192.168.1.2` e
`HLS_HOST_PORT=8888`. Reserve esse IP no roteador ou atualize-o se mudar.
A regra Windows **GuixMonitor HLS TV LAN** permite TCP 8888 somente de
`192.168.1.0/24` para esse IP. A porta 1935 fica em loopback.
A pedido do operador, a regra adicional **GuixMonitor HLS TV Internet**
permite TCP 8888 de qualquer origem para `192.168.1.2`. Para acesso externo,
configure no roteador um encaminhamento TCP da porta WAN `8888` para
`192.168.1.2:8888`. O endereco sera `http://IP_PUBLICO:8888/obs/`
(`http://201.66.73.13:8888/obs/` se esse ainda for o IP publico).
Nao encaminhe a porta 1935: a publicacao RTMP do OBS permanece local.
Nao e necessario alterar o destino de transmissao do OBS nem reiniciar
os containers para esse encaminhamento.

HLS nao tem autenticacao nem HTTPS e tambem pode reproduzir outros caminhos
publicados no MediaMTX, nao apenas `obs`. Expor TCP 8888 permite que qualquer
pessoa que alcance essa porta assista aos streams; prefira VPN ou acesso
restrito quando houver imagens privadas. O acesso externo depende do
encaminhamento no roteador e de um IP publico acessivel, sem CGNAT.
Teste por dados moveis: acessar o IP publico na propria rede pode falhar se
o roteador nao suportar NAT loopback. Para voltar ao acesso somente local,
desabilite a regra **GuixMonitor HLS TV Internet** e remova o encaminhamento
no roteador.

## Controle de cenas do OBS

Com `OBS_WEBSOCKET_URL` configurado e o OBS conectado, o painel lista as cenas
da coleção ativa. Clique em qualquer cena para torná-la ativa; a cena atual fica
destacada. A lista é atualizada quando cenas são criadas, removidas ou
renomeadas no OBS. A quantidade exibida corresponde às cenas que o OBS retorna
para a coleção atualmente aberta.

## Diagnóstico

`GET http://localhost:18081/healthz` verifica a saúde do serviço. `GET
http://localhost:18081/api/status` informa os terminais, conexões JT1078, estado
dos publicadores RTSP e diagnósticos do FFmpeg.

Cada publicador expõe `outputProgress` em `/api/status`, obtido de
`ffmpeg -progress`: `frames` é a contagem de vídeo processado na saída,
`outTimeUs` é o tempo de saída em microssegundos, `speed` é a velocidade
reportada e `lastVideoAdvanceAtMs`/`lastTimeAdvanceAtMs` indicam o último
avanço. Esses dados são distintos de `videoFrames`/`audioFrames`, que contam
escritas aceitas nos pipes, não publicação efetiva. O progresso do FFmpeg
não confirma reprodução no OBS nem fornece contagem separada de áudio publicado.
Um relatório recebido sem avanço de `frames` não significa vídeo fluido.

O evento `rtsp-media-flow-sample`, a cada 5 segundos por publicador, correlaciona
quadros recebidos (`received`), escritos (`written`), progresso de saída
(`output`) e filas/bloqueios (`timing`). As medições reiniciam com cada
publicador e os temporizadores são encerrados junto com ele.

### Recuperar transmissão

O botão **Recuperar transmissão** analisa separadamente os canais habilitados
do terminal e não interrompe um canal saudável:

- Se a fila de escrita acumular pelo menos 1 segundo de atraso, descarta
  vídeo antigo até o quadro-chave mais recente. Se não houver quadro-chave
  na fila, aguarda o próximo. O áudio não é desativado.
- Se o FFmpeg estiver bloqueado por pelo menos 3 segundos, em erro ou sem
  progresso após a primeira ação, reinicia somente o publicador afetado.
- Se não chegar um quadro de vídeo completo por 5 segundos, solicita
  novamente mídia daquele canal com o comando JT808 `0x9101`, preservando
  o tipo de fluxo configurado e a solicitação de áudio/vídeo. Não duplica
  comandos pendentes nem reativa canais parados manualmente.
- Verifica avanço real de `outputProgress.frames` do FFmpeg, chegada de vídeo,
  RTSP publicado e entrada de áudio quando habilitada por uma janela de
  2 segundos. Receber relatórios sem avanço de vídeo não confirma recuperação.
  O painel mostra
  o resultado de cada canal; se não recuperar em 30 segundos, mostra erro.
  Esse diagnóstico não confirma a reprodução ou o áudio no OBS remoto.

Há um intervalo mínimo de 30 segundos entre pedidos, aplicado também pela API.
O endpoint continua sendo `POST /api/terminals/{terminalId}/video/resync`;
responde com o estado da recuperação, não com sucesso antecipado. O progresso
é publicado via SSE e aparece em `terminals[].recovery` em `/api/status`.
O botão não altera bitrate/qualidade, não reinicia o container e não corrige
falta de cobertura móvel. A recuperação automática já existente continua ativa.

### Coordenacao das tentativas de retomada

O inicio automatico, a reconexao JT1078, o timeout/recusa de `0x9101` e a
recuperacao usam os mesmos comandos pendentes e temporizadores por canal.
Tanto o botao quanto o monitor aguardam um comando, a janela de chegada de
video ou uma tentativa de retomada ja agendada. Nao cancelam esse prazo para
enviar outro pedido nem reiniciam o publicador durante essa espera.
Quando a espera termina, a recuperacao reavalia o canal.

Sem video recente, pedidos recusados, sem confirmacao em 15 segundos ou com
falha TCP entram na mesma fila de retomada, com intervalos de 1, 2, 4, 8, 16
e ate 30 segundos. Apos aceite, a camera tem 20 segundos para enviar video.
Audio sozinho nao encerra essa espera, nao cancela a retomada e nao reinicia
o contador de falhas. O backoff so e zerado depois de pelo menos 5 segundos
de chegada continuada de video (sem lacuna de 5 segundos).

Se o video estiver chegando mesmo sem confirmacao JT808, o servidor registra
`video-start-ack-missing`, mantem o status do comando como `timeout` e preserva
o fluxo: nao trata a ausencia de ACK como ausencia de midia. Falhas de pedidos
de inicio nao fecham conexoes de midia compartilhadas com outros canais.
A parada explicita do operador continua sendo respeitada, inclusive quando
uma confirmacao de inicio chega atrasada.

`terminals[].videoChannels` em `/api/status` expoe `cameraRetryAttempts` e
`cameraRetryPending`; o estado da recuperacao informa quando esta aguardando
a tentativa existente. Desativar `VIDEO_AUTO_RECOVERY_ENABLED` desativa o
monitor de publicadores, mas nao essa retomada de camera.

### Recuperação automática

A recuperação seletiva também é executada automaticamente no servidor, mesmo
com o navegador fechado. O monitor verifica os canais a cada segundo e usa as
mesmas ações do botão, preservando o áudio e o tipo de fluxo configurado.
Somente os canais afetados entram na recuperação.

Para evitar reinícios desnecessários, aguarda 20 segundos após observar um
canal habilitado/conectado e exige que o problema persista por 3 segundos.
Essa tolerância reinicia a cada novo publicador; a inicialização não é
interrompida por um bloqueio transitório dos pipes antes dos 20 segundos.
Detecta ausência de vídeo por 5 segundos, filas atrasadas, bloqueio de escrita
no FFmpeg, publicador indisponível/inicialização demorada e falta de avanço
da saída real de vídeo. Nos modos `strict-arrival` e `bounded-sync`, uma espera
intencional de sincronização não é tratada como falha de avanço e não reinicia
os publicadores;
ausência real de quadros de vídeo, erro do FFmpeg, fila atrasada ou pipe
bloqueado continuam acionando a recuperação correspondente. Áudio ausente na
origem é sinalizado no painel, mas não reinicia sozinho um publicador cujo vídeo
continua avançando.
Não avalia reprodução no OBS remoto.

### Áudio ausente ou atrasado na inicialização

Todos os canais com áudio solicitado aguardam seu primeiro quadro por até
`RTSP_AUDIO_ARRIVAL_TIMEOUT_MS` (8 segundos por padrão). Se não chegar, somente
esse publicador é reiniciado no próximo quadro-chave com vídeo temporário.
O fluxo principal e o pedido de áudio/vídeo à câmera não são alterados.
`audioRequested=true`, `audioEnabled=false` e `audioState=waiting` indicam
essa situação no status; o painel informa que aguarda áudio da câmera.
O monitor não fica reiniciando um vídeo saudável porque o áudio ainda falta,
ou porque a chegada de áudio se interrompe depois da inicialização.
No modo `strict-arrival`, se o áudio ou qualquer um dos vídeos ficar ausente ou
fora da tolerância, as três saídas ficam em `holding` até que as faixas voltem
a estar alinhadas. No modo `bounded-sync`, a espera conjunta tem limite:
atingido `RTSP_SYNC_HOLD_TIMEOUT_MS`, as saídas passam a `degraded` e continuam
até que todas as faixas voltem à tolerância.

Assim que um quadro AAC válido chegar, o estado muda para `restoring`.
No próximo quadro-chave, uma única reinicialização local incorpora o áudio,
reutilizando o quadro AAC recente para destravar a leitura inicial do FFmpeg.
Nenhum canal irmão é interrompido. O estado `active` indica áudio recebido,
não uma confirmação de som no OBS. Após 5 segundos sem nova chegada, o áudio
é indicado como `stalled` no painel. Quadros em cache com mais de 5 segundos
não são usados para restaurar o publicador. Som ausente na origem não pode
ser recuperado pelo gateway.

Não reativa canais parados manualmente, não age enquanto o terminal estiver
desconectado e aguarda comandos JT808 ou os temporizadores de reconexão já
existentes. Não inicia outra recuperação enquanto uma manual ou automática
estiver em andamento. Depois de uma recuperação automática bem-sucedida,
aguarda 30 segundos antes de outra; após falhas consecutivas, aguarda 60, 120,
240 e até 300 segundos entre tentativas, sem parar o monitor.

O painel identifica **Recuperação automática** e mostra os resultados por
canal. `/api/status` expõe `terminals[].autoRecoveryEnabled` e
`terminals[].recovery.source` (`automatic` ou `manual`); os logs registram o
motivo e o progresso no evento `video-recovery-progress`.
Para desligar apenas este monitor e manter o botão e a reconexão já existente,
defina `VIDEO_AUTO_RECOVERY_ENABLED=false` e recrie o serviço.

Eventos úteis:

- `terminal-registration`, `terminal-login` e `terminal-heartbeat`: sinalização
  JT808;
- `av-capabilities`: capacidades AV recebidas;
- `media-connection-open`, `media-progress` e `jt1078-signature-detected`:
  atividade JT1078;
- `rtsp-media-publisher-starting`, `rtsp-media-published`,
  `rtsp-media-gop-dropped`, `rtsp-media-pipeline-error` e
  `rtsp-media-auto-restart`: estado e recuperação da publicação.

## Configuração

- `VIDEO_AUTO_RECOVERY_ENABLED`: ativa o monitor de recuperação seletiva
  (`true` por padrão; aceita somente `true` ou `false`).
- `JT808_HOST_PORT`: porta JT808 publicada no PC (padrão `6608`);
- `JT808_BIND_IP`: endereço de bind JT808 (padrão `0.0.0.0`);
- `JT808_AUTH_CODE`: código usado na resposta de registro JT808;
- `JT1078_PUBLIC_IP`: IPv4 público anunciado à câmera (padrão `201.66.73.13`);
- `JT1078_PUBLIC_PORT`: porta JT1078 publicada/anunciada (padrão `1078`);
- `JT1078_BIND_IP`: endereço de bind JT1078 (padrão `0.0.0.0`);
- `JT1078_RTSP_BASE_URL`: URL interna do servidor RTSP (padrão
  `rtsp://mediamtx:8554`);
- `RTSP_MEDIA_ENABLED`: habilita o publicador RTSP (padrão `true`).
- `RTSP_TIMESTAMP_MODE`: `transport` (padrão, timestamps explícitos) ou
  `wallclock` (modo anterior, horários gerados ao ler os pipes). A
  sincronização `strict-arrival` e `bounded-sync` exige `transport`.
- `RTSP_SYNC_MODE`: `bounded-sync` (padrão; usa uma linha do tempo comum e
  libera as três saídas após espera limitada), `strict-arrival` (sincroniza as
  três faixas, esperando sem limite) ou `best-effort` (relógios independentes,
  sem bloqueio conjunto).
- `RTSP_SYNC_TOLERANCE_MS`: desvio máximo de origem para sincronização (padrão
  `250` ms; intervalo de `50` a `2500` ms). Reduzir a tolerância exige chegadas
  mais próximas, mas pode aumentar as esperas; aumentá-la reduz esperas ao custo
  de permitir maior diferença entre faixas. O estado e os
  desvios atuais são expostos em `rtspStreams[].syncStatus` e
  `rtspAudioStream.syncStatus` no endpoint `/api/status`.
- `RTSP_SYNC_MAX_SCHEDULE_AHEAD_MS`: avanço máximo do agendamento JT1078 além
  de `RTSP_JITTER_BUFFER_MS` antes de recentrar um quadro-chave ou descartar
  quadros atrasados (padrão `750` ms; intervalo de `50` a `5000` ms). Esse
  limite permite maior latência comum para evitar descartes, sem alterar a
  tolerância de sincronização entre vídeo 1, vídeo 2 e áudio.
- `RTSP_SYNC_HOLD_TIMEOUT_MS`: espera máxima do modo `bounded-sync` antes de
  liberar as três saídas em estado degradado (padrão `250` ms; intervalo de
  `50` a `2500` ms). Quando todas as faixas voltam à tolerância, o estado
  retorna a `aligned`.
- `RTSP_TIMESTAMP_SCALE_MS_PER_UNIT`: milissegundos por unidade JT1078
  (`1` por padrão, intervalo `0.000001` a `1000`). Não ajuste pela velocidade
  da rede; use apenas se a unidade do firmware tiver sido confirmada.
- `RTSP_JITTER_BUFFER_MS`: atraso/reserva de reprodução para jitter (intervalo
  de `0` a `8000` ms; configurado em `0` neste ambiente). Aumentar este valor
  aumenta a latência e a margem para absorver variações, mas não substitui
  timestamps confiáveis de captura nem garante sincronismo absoluto.
- `RTSP_CLOCK_CALIBRATION_TIMEOUT_MS`: no modo `best-effort`, prazo (padrão
  `1500` ms; intervalo de
  `100` a `10000` ms) para calibrar o relógio de cada canal contra o
  timestamp de origem da câmera (JT1078), validando avanços na unidade
  configurada, independentemente da chegada local. Se a validação não ocorrer dentro desse prazo (ou após
  acumular quadros de início suficientes), o canal cai em modo
  `arrival-fallback`, usando chegada e intervalos de mídia. O campo
  `timing.syncClockScope` descreve o modo de pacing daquele canal; no modo
  `transport`, os PTS de saída continuam usando a origem comum indicada por
  `mediaClock.syncClockScope`. Um valor maior tolera mais instabilidade de rede
  (comum em 4G/5G) antes de desistir da calibração.
- `RTSP_CLOCK_CALIBRATION_SPAN_MS`: no modo `best-effort`, intervalo mínimo
  (padrão `80` ms;
  intervalo de `10` ms até `RTSP_CLOCK_CALIBRATION_TIMEOUT_MS`) entre duas
  amostras de origem, na unidade configurada, necessário para validar o relógio.
  Um valor menor permite validar mais rápido (com amostras mais
  próximas), reduzindo a chance de cair em `arrival-fallback` quando a rede
  é instável. Acompanhe o campo `timing.syncClockScope` em `/api/status`
  (valores `stream-source-timestamp` indicam calibração bem-sucedida;
  `arrival-fallback` indica que o canal não calibrou).
- `RTSP_GOP_DROP_QUEUE_BYTES`: limite de bytes enfileirados para o FFmpeg
  (padrão `262144` = 256 KB; intervalo de `65536` a `1048576`) a partir do
  qual o gateway descarta quadros antigos até o próximo quadro-chave para
  recuperar o atraso de publicação. Canais mais pesados (ex.: canal 1 com
  vídeo em alta qualidade + áudio) tendem a acumular fila sob banda móvel
  restrita; um limite menor faz o descarte ocorrer mais cedo e em lotes
  menores, reduzindo a chance de a fila crescer até o limite fatal de
  `1048576` bytes (que derruba a publicação).
- `JT1078_CHANNEL_2_STREAM_TYPE`: fluxo do canal 2 (`0` fluxo principal por
  padrão; `1` subfluxo). Selecionar `1` reduz o uso de banda e a resolução do
  canal 2.
- `JT1078_CHANNEL_1_STREAM_TYPE`: fluxo do canal 1 (`0` fluxo principal por
  padrão; `1` subfluxo). Use `1` para reduzir a qualidade/bitrate do canal 1 e
  melhorar a fluidez em redes móveis instáveis, ao custo de resolução. O áudio
  compartilhado vem deste canal.
- `JT1078_CHANNEL_1_FORCE_AUDIO`: quando `true`, solicita áudio no canal 1
  mesmo que `JT1078_CHANNEL_1_STREAM_TYPE=1` (subfluxo). Não há garantia de
  que o subfluxo da câmera carregue áudio; no modelo A3-LA em uso, testes
  anteriores observaram áudio ausente ou intermitente nesse modo. A opção está
  ativada neste ambiente a pedido do operador.
  O watchdog usa o prazo de chegada em todos os canais com áudio solicitado.
  No modo de saídas RTSP separadas, se nenhum áudio chegar dentro de
  `RTSP_AUDIO_ARRIVAL_TIMEOUT_MS`, ou se o áudio parar de chegar, o gateway
  mantém o vídeo do canal 1 ativo e não encerra o publicador independente de
  áudio. O estado do áudio permanece em espera antes do primeiro pacote e passa
  a `stalled` após uma lacuna; novos pacotes são enviados pelo mesmo caminho
  independente. Nos subfluxos experimentais,
  também permite nova tentativa após `RTSP_AUDIO_RETRY_COOLDOWN_MS`: na
  próxima reconexão após o cooldown, o gateway tenta áudio novamente
  automaticamente, em vez de ficar sem áudio até o processo ser reiniciado.
  O botão **Recuperar transmissão** também libera uma nova tentativa de áudio
  ao reiniciar um publicador ou pedir mídia novamente à câmera, ignorando
  esse cooldown experimental. Nos fluxos principais (`0`), não há nova
  tentativa cega de áudio após o cooldown: o vídeo permanece disponível e
  o áudio é incorporado quando efetivamente chegar. Acompanhe o evento
  `rtsp-media-audio-unavailable` no painel/logs e o campo
  `audioDiagnostics.framesReceived` em `/api/status` para confirmar
  empiricamente se o subfluxo desta câmera carrega áudio. Para este modelo, o
  fluxo principal (`JT1078_CHANNEL_1_STREAM_TYPE=0`) é a opção mais confiável
  quando o áudio compartilhado é necessário; use o subfluxo somente se o
  áudio puder ser dispensado ou se novos testes confirmarem sua disponibilidade.
- `RTSP_AUDIO_ARRIVAL_TIMEOUT_MS`: prazo (padrão `8000` ms; intervalo de
  `1000` a `60000` ms) para o watchdog aguardar o primeiro pacote de áudio
  antes de publicar vídeo temporário; também define quanto tempo o modo
  `strict-arrival` usa esse prazo para diagnosticar áudio ausente e mantém as
  três saídas em espera; `bounded-sync` também monitora a ausência, mas libera
  as saídas após `RTSP_SYNC_HOLD_TIMEOUT_MS`.
- `RTSP_AUDIO_RETRY_COOLDOWN_MS`: por quanto tempo (padrão `120000` ms, ou
  2 min; intervalo de `0` a `3600000` ms) o watchdog de áudio "lembra" que um
  fluxo não trouxe áudio antes de permitir uma nova tentativa automática na
  próxima reconexão. Use `0` para tentar áudio a cada reconexão (útil para
  diagnosticar se o subfluxo eventualmente traz áudio); aumente para reduzir
  a frequência de tentativas/restarts quando o subfluxo desta câmera
  comprovadamente nunca carrega áudio.
- `JT1078_SOCKET_IDLE_TIMEOUT_MS`: tempo máximo (padrão `20000` ms; intervalo
  de `1000` a `120000` ms) sem receber dados numa conexão JT1078 da câmera
  antes de encerrá-la proativamente e pedir reinício do fluxo. Deve
  permanecer bem abaixo do `readTimeout` do MediaMTX (veja abaixo) para que o
  gateway detecte e recupere conexões travadas antes que o FFmpeg/MediaMTX
  percam a publicação sozinhos, reduzindo o tempo de interrupção visível no
  OBS a cada queda de conexão móvel. Após o fechamento da última conexão de
  mídia de um canal, os publishers RTSP permanecem ativos pelo prazo configurado
  em `JT1078_RECONNECT_GRACE_MS`
  enquanto o gateway aguarda uma reconexão; a janela é cancelada assim que
  novos pacotes do canal chegam. Paradas manuais continuam imediatas.
- `JT1078_RECONNECT_GRACE_MS`: prazo (padrão `30000` ms; intervalo de `0` a
  `55000` ms) em que os publishers RTSP permanecem ativos após o fechamento
  da última conexão JT1078 do canal. `0` restaura o encerramento imediato;
  mantenha o prazo abaixo do `readTimeout` do MediaMTX.
- `mediamtx.yml`: `readTimeout: 60s` tolera interrupções móveis breves e
  picos de atraso na publicação (ex.: durante o descarte de quadros do
  canal 1) sem encerrar imediatamente o publicador; falhas contínuas da rede
  ainda exigem recuperação da conexão da câmera.

## Testes

```powershell
npm test
docker compose config
```
