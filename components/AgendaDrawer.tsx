"use client";

// 2/out -- pedido do Douglas, mesmo espírito da unificação do chat
// ("ChatDrawer" virou components/ChatDrawer.tsx, ver comentário grande
// no topo dele): "quero ela [a agenda] toda isolada tambem, e sistema
// unico, assim como o chat, funcionando acima de tudo, acima de lobby
// acima de jogo". AgendaDrawer morava só dentro de GameRoom.tsx (função
// local, não-exportada) -- o Lobby não tinha como reusar essa peça
// visual de verdade, só reimplementar uma parecida do zero
// (LobbyAgendaPanel em Lobby.tsx, REST em vez de socket -- a mesma
// "unificação só de aparência" que o chat tinha antes). Extraído pra cá
// SEM MUDAR UMA LINHA de lógica/JSX -- só move, exporta, e importa os
// tipos/ícones/formatadores que precisa de GameRoom.tsx (mesmo padrão
// de ChatDrawer.tsx logo abaixo). Usado dos dois lados agora (GameRoom.tsx
// e Lobby.tsx) alimentado pelo MESMO estado vindo de usePlatformChat.ts
// (ver comentário grande de lá sobre agenda).
import {
  MicIcon,
  CamIcon,
  ScreenIcon,
  BackIcon,
  CloseIcon,
  FileIcon,
  PlusIcon,
  attachmentUrl,
  formatFileSize,
  localDateStr,
  formatCallDateTime,
  dayChipLabel,
  type CallEvent,
  type AgendaFormState,
  type DirectoryUser,
  type RemotePlayer,
} from "./GameRoom";

export function AgendaDrawer({
  myUserId,
  onlinePlayers,
  allUsers,
  calls,
  busyUserIds,
  agendaView,
  onChangeAgendaView,
  agendaDetailId,
  onOpenCallDetail,
  agendaForm,
  onChangeAgendaForm,
  onToggleAgendaParticipant,
  agendaError,
  onStartNewCall,
  editingCallId,
  onEditCall,
  onDeleteCall,
  onSubmitCreateCall,
  onRespondToCall,
  agendaSearchQuery,
  onChangeAgendaSearchQuery,
  agendaColleagueId,
  agendaColleagueName,
  colleagueCalls,
  onViewColleagueAgenda,
  onBackToMyAgenda,
  onPickAgendaFile,
  onRemoveAgendaAttachment,
  sendingAgendaAttachment,
  onPickDetailAttachment,
  sendingDetailAttachment,
  expandedAgendaDays,
  onToggleAgendaDay,
  onClose,
}: {
  myUserId: string;
  onlinePlayers: RemotePlayer[];
  allUsers: DirectoryUser[];
  calls: CallEvent[];
  busyUserIds: string[];
  agendaView: "list" | "new" | "detail" | "colleague";
  onChangeAgendaView: (v: "list" | "new" | "detail" | "colleague") => void;
  agendaDetailId: string | null;
  onOpenCallDetail: (callId: string) => void;
  agendaForm: AgendaFormState;
  onChangeAgendaForm: (partial: Partial<AgendaFormState>) => void;
  onToggleAgendaParticipant: (userId: string) => void;
  agendaError: string | null;
  onStartNewCall: () => void;
  editingCallId: string | null;
  onEditCall: (call: CallEvent) => void;
  onDeleteCall: (callId: string) => void;
  onSubmitCreateCall: () => void;
  onRespondToCall: (callId: string, status: "approved" | "declined") => void;
  agendaSearchQuery: string;
  onChangeAgendaSearchQuery: (v: string) => void;
  agendaColleagueId: string | null;
  agendaColleagueName: string;
  colleagueCalls: CallEvent[];
  onViewColleagueAgenda: (userId: string, name: string) => void;
  onBackToMyAgenda: () => void;
  onPickAgendaFile: () => void;
  onRemoveAgendaAttachment: (index: number) => void;
  sendingAgendaAttachment: boolean;
  onPickDetailAttachment: () => void;
  sendingDetailAttachment: boolean;
  expandedAgendaDays: Set<string>;
  onToggleAgendaDay: (dateKey: string) => void;
  onClose: () => void;
}) {
  const detailCall = calls.find((c) => c.id === agendaDetailId) ?? colleagueCalls.find((c) => c.id === agendaDetailId) ?? null;
  const myCallStatus = detailCall?.participants.find((p) => p.id === myUserId)?.status ?? null;
  const onlineUserIds = new Set(onlinePlayers.map((p) => p.userId));
  // todo mundo cadastrado no ambiente, menos eu (ver allUsers/users:list
  // em server/chatStore.js) -- usado tanto no picker de participantes do
  // "Marcar compromisso" quanto em "pesquise a agenda de um colega",
  // independente de quem tá online agora (ver comentário no tipo
  // DirectoryUser).
  const roster = allUsers.filter((u) => u.userId !== myUserId);
  const colleagueQuery = agendaSearchQuery.trim().toLowerCase();
  const colleagueMatches =
    colleagueQuery.length === 0 ? [] : roster.filter((u) => (u.name || "").toLowerCase().includes(colleagueQuery));

  // "hoje | amanhã | 25/set | 26/set" -- ver comentário grande no
  // useState de expandedAgendaDays em GameRoom(). Agrupa as calls
  // futuras (de hoje em diante) por dia local; o strip sempre mostra os
  // próximos 7 dias corridos, mais qualquer dia além disso que já tenha
  // algum compromisso (pra não esconder nada).
  const now = new Date();
  const todayKey = localDateStr(now);
  const tomorrowKey = localDateStr(new Date(now.getTime() + 86_400_000));
  const callsByDay = new Map<string, CallEvent[]>();
  for (const c of calls) {
    const key = localDateStr(new Date(c.startTs));
    if (key < todayKey) continue; // passado não entra no strip -- só o que vem daqui pra frente
    if (!callsByDay.has(key)) callsByDay.set(key, []);
    callsByDay.get(key)!.push(c);
  }
  const stripDays: string[] = [];
  for (let i = 0; i < 7; i++) stripDays.push(localDateStr(new Date(now.getTime() + i * 86_400_000)));
  for (const key of callsByDay.keys()) if (!stripDays.includes(key)) stripDays.push(key);
  stripDays.sort();
  function renderCallItem(c: CallEvent) {
    const mine = c.participants.find((p) => p.id === myUserId);
    const approvedCount = c.participants.filter((p) => p.status === "approved").length;
    const soloCall = c.participants.length <= 1;
    return (
      <button key={c.id} className="agenda-call-item" onClick={() => onOpenCallDetail(c.id)}>
        <span className="agenda-call-item-main">
          <span className="agenda-call-title">
            {c.visibility === "private" && "🔒 "}
            {c.title}
          </span>
          <span className="agenda-call-when">
            {formatCallDateTime(c.startTs)} · {c.durationMinutes}min
            {c.blocksAgenda === false && " · não trava agenda"}
          </span>
        </span>
        {soloCall && <span className="agenda-badge">Pessoal</span>}
        {!soloCall && mine?.status === "pending" && <span className="agenda-badge pending">Aguardando você</span>}
        {!soloCall && mine?.status === "declined" && <span className="agenda-badge declined">Recusada</span>}
        {!soloCall && mine?.status === "approved" && (
          <span className="agenda-badge approved">
            {approvedCount}/{c.participants.length} confirmados
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="chat-drawer agenda-drawer">
      {agendaView === "list" && (
        <>
          <div className="chat-drawer-header">
            <h3>Minha agenda</h3>
            <div className="chat-drawer-header-actions">
              <button className="chat-icon-btn" title="Marcar compromisso" onClick={onStartNewCall}>
                <PlusIcon />
              </button>
              <button className="chat-icon-btn" title="Fechar" onClick={onClose}>
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="agenda-search-row">
            <input
              className="agenda-search-input"
              value={agendaSearchQuery}
              onChange={(e) => onChangeAgendaSearchQuery(e.target.value)}
              placeholder="Pesquise a agenda de um colega..."
            />
            {colleagueQuery.length > 0 && (
              <div className="agenda-search-results">
                {colleagueMatches.length === 0 && <p className="chat-empty-hint">Ninguém encontrado.</p>}
                {colleagueMatches.map((p) => (
                  <button
                    key={p.userId}
                    className="agenda-search-result-item"
                    onClick={() => onViewColleagueAgenda(p.userId, p.name || "Sem nome")}
                  >
                    <span className="chat-conv-avatar" style={{ background: p.color }}>
                      {(p.name || "?").slice(0, 1).toUpperCase()}
                    </span>
                    <span>{p.name || "Sem nome"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="agenda-day-strip">
            {stripDays.map((key) => {
              const dayCalls = callsByDay.get(key) ?? [];
              const expanded = expandedAgendaDays.has(key);
              return (
                <button
                  key={key}
                  className={expanded ? "agenda-day-chip active" : "agenda-day-chip"}
                  onClick={() => onToggleAgendaDay(key)}
                >
                  {dayChipLabel(key, todayKey, tomorrowKey)}
                  {dayCalls.length > 0 && <span className="agenda-day-chip-count">{dayCalls.length}</span>}
                </button>
              );
            })}
          </div>
          <div className="agenda-call-list">
            {calls.length === 0 && <p className="chat-empty-hint">Nenhum compromisso marcado ainda.</p>}
            {stripDays
              .filter((key) => expandedAgendaDays.has(key))
              .map((key) => {
                const dayCalls = (callsByDay.get(key) ?? []).slice().sort((a, b) => a.startTs - b.startTs);
                return (
                  <div key={key} className="agenda-day-group">
                    <p className="agenda-day-group-label">{dayChipLabel(key, todayKey, tomorrowKey)}</p>
                    {dayCalls.length === 0 ? (
                      <p className="chat-empty-hint agenda-day-group-empty">Nada marcado.</p>
                    ) : (
                      dayCalls.map(renderCallItem)
                    )}
                  </div>
                );
              })}
          </div>
        </>
      )}

      {agendaView === "colleague" && (
        <>
          <div className="chat-drawer-header">
            <button className="chat-icon-btn" title="Voltar pra minha agenda" onClick={onBackToMyAgenda}>
              <BackIcon />
            </button>
            <h3>Agenda de {agendaColleagueName}</h3>
            <div className="chat-drawer-header-actions">
              <button className="chat-icon-btn" title="Fechar" onClick={onClose}>
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="agenda-call-list">
            {colleagueCalls.length === 0 && (
              <p className="chat-empty-hint">Nenhum compromisso marcado por enquanto.</p>
            )}
            {colleagueCalls.map((c) =>
              c.redacted ? (
                <div key={c.id} className="agenda-call-item agenda-call-item-private">
                  <span className="agenda-call-item-main">
                    <span className="agenda-call-title agenda-call-title-private">🔒 Conteúdo da agenda privado</span>
                    <span className="agenda-call-when">
                      {formatCallDateTime(c.startTs)} · {c.durationMinutes}min
                    </span>
                  </span>
                </div>
              ) : (
                <button key={c.id} className="agenda-call-item" onClick={() => onOpenCallDetail(c.id)}>
                  <span className="agenda-call-item-main">
                    <span className="agenda-call-title">{c.title}</span>
                    <span className="agenda-call-when">
                      {formatCallDateTime(c.startTs)} · {c.durationMinutes}min
                    </span>
                  </span>
                </button>
              )
            )}
          </div>
        </>
      )}

      {agendaView === "new" && (
        <>
          <div className="chat-drawer-header">
            <button className="chat-icon-btn" title="Voltar" onClick={() => onChangeAgendaView("list")}>
              <BackIcon />
            </button>
            <h3>{editingCallId ? "Editar compromisso" : "Marcar compromisso"}</h3>
            <div className="chat-drawer-header-actions">
              <button className="chat-icon-btn" title="Fechar" onClick={onClose}>
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="agenda-form-body">
            <label className="chat-field">
              <span>Título</span>
              <input
                value={agendaForm.title}
                onChange={(e) => onChangeAgendaForm({ title: e.target.value })}
                placeholder="Ex: Alinhamento do projeto"
                maxLength={80}
              />
            </label>
            <label className="chat-field">
              <span>Descrição (opcional)</span>
              <textarea
                className="agenda-description-input"
                value={agendaForm.description}
                onChange={(e) => onChangeAgendaForm({ description: e.target.value })}
                placeholder="Detalhes do compromisso..."
                maxLength={2000}
                rows={3}
              />
            </label>
            <div className="agenda-datetime-row">
              <label className="chat-field">
                <span>Data</span>
                <input type="date" value={agendaForm.date} onChange={(e) => onChangeAgendaForm({ date: e.target.value })} />
              </label>
              <label className="chat-field">
                <span>Horário</span>
                <input type="time" value={agendaForm.time} onChange={(e) => onChangeAgendaForm({ time: e.target.value })} />
              </label>
              <label className="chat-field">
                <span>Duração</span>
                <select
                  value={agendaForm.durationMinutes}
                  onChange={(e) => onChangeAgendaForm({ durationMinutes: Number(e.target.value) })}
                >
                  <option value={15}>15 min</option>
                  <option value={30}>30 min</option>
                  <option value={45}>45 min</option>
                  <option value={60}>1h</option>
                  <option value={90}>1h30</option>
                </select>
              </label>
            </div>

            {!editingCallId && (
            <>
            <div className="agenda-needs-row">
              <span className="agenda-field-label">Necessidades</span>
              <label className="agenda-need-check">
                <input
                  type="checkbox"
                  checked={agendaForm.needs.camera}
                  onChange={(e) => onChangeAgendaForm({ needs: { ...agendaForm.needs, camera: e.target.checked } })}
                />
                <CamIcon off={false} /> Câmera
              </label>
              <label className="agenda-need-check">
                <input
                  type="checkbox"
                  checked={agendaForm.needs.audio}
                  onChange={(e) => onChangeAgendaForm({ needs: { ...agendaForm.needs, audio: e.target.checked } })}
                />
                <MicIcon off={false} /> Áudio
              </label>
              <label className="agenda-need-check">
                <input
                  type="checkbox"
                  checked={agendaForm.needs.screen}
                  onChange={(e) => onChangeAgendaForm({ needs: { ...agendaForm.needs, screen: e.target.checked } })}
                />
                <ScreenIcon active={false} /> Tela
              </label>
            </div>

            <div className="agenda-visibility-row">
              <span className="agenda-field-label">Visibilidade</span>
              <div className="agenda-visibility-toggle">
                <button
                  type="button"
                  className={agendaForm.visibility === "public" ? "agenda-visibility-btn active" : "agenda-visibility-btn"}
                  onClick={() => onChangeAgendaForm({ visibility: "public" })}
                >
                  Público
                </button>
                <button
                  type="button"
                  className={agendaForm.visibility === "private" ? "agenda-visibility-btn active" : "agenda-visibility-btn"}
                  onClick={() => onChangeAgendaForm({ visibility: "private" })}
                >
                  Privado
                </button>
              </div>
              <p className="agenda-visibility-hint">
                {agendaForm.visibility === "public"
                  ? "Quem pesquisar a agenda de um participante vê o conteúdo desse compromisso."
                  : 'Quem pesquisar a agenda de um participante só vê o horário ocupado, com "conteúdo da agenda privado".'}
              </p>
            </div>

            <div className="agenda-visibility-row">
              <span className="agenda-field-label">Ocupação na agenda</span>
              <div className="agenda-visibility-toggle">
                <button
                  type="button"
                  className={agendaForm.blocksAgenda ? "agenda-visibility-btn active" : "agenda-visibility-btn"}
                  onClick={() => onChangeAgendaForm({ blocksAgenda: true })}
                >
                  Travar agenda
                </button>
                <button
                  type="button"
                  className={!agendaForm.blocksAgenda ? "agenda-visibility-btn active" : "agenda-visibility-btn"}
                  onClick={() => onChangeAgendaForm({ blocksAgenda: false })}
                >
                  Mostrar sem travar
                </button>
              </div>
              <p className="agenda-visibility-hint">
                {agendaForm.blocksAgenda
                  ? "Ocupa o horário -- quem for convidado pra outro compromisso no mesmo horário aparece como indisponível."
                  : "Só aparece na agenda, sem travar o horário -- dá pra marcar outro compromisso em cima desse."}
              </p>
            </div>

            <div className="agenda-attachment-field">
              <span className="agenda-field-label">Anexos (visíveis pra todos da call)</span>
              {agendaForm.attachments.length > 0 && (
                <div className="agenda-attachment-list">
                  {agendaForm.attachments.map((a, i) => (
                    <div key={`${a.url}-${i}`} className="chat-attachment-file agenda-attachment-pending">
                      <FileIcon />
                      <span className="chat-attachment-file-info">
                        <span className="chat-attachment-file-name">{a.name}</span>
                        <span className="chat-attachment-file-size">{formatFileSize(a.size)}</span>
                      </span>
                      <button
                        type="button"
                        className="chat-icon-btn"
                        title="Remover anexo"
                        onClick={() => onRemoveAgendaAttachment(i)}
                      >
                        <CloseIcon />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button type="button" className="chat-secondary-btn" onClick={onPickAgendaFile} disabled={sendingAgendaAttachment}>
                {sendingAgendaAttachment ? "Enviando..." : "+ Anexar arquivo"}
              </button>
            </div>
            </>
            )}

            {/* editar não mexe em quem foi convidado (mesma trava de
                sempre -- nem o servidor aceita participantIds no
                update, ver handleAgendaUpdate em server/index.js) --
                só mostra quem já tá convidado, sem picker. */}
            {editingCallId ? (
              <div className="agenda-attachment-field">
                <span className="agenda-field-label">Convidados</span>
                <p className="chat-empty-hint">
                  {agendaForm.participantIds.length === 0
                    ? "Só você"
                    : agendaForm.participantIds
                        .map((id) => allUsers.find((u) => u.userId === id)?.name || "Alguém")
                        .join(", ")}
                </p>
              </div>
            ) : (
              <>
            <span className="agenda-field-label">Participantes (opcional -- deixe vazio pra um compromisso só seu)</span>
            {roster.length === 0 ? (
              <p className="chat-empty-hint">Ainda não tem mais ninguém cadastrado no ambiente.</p>
            ) : (
              <div className="chat-picker-list">
                {roster.map((u) => {
                  const busy = busyUserIds.includes(u.userId);
                  const selected = agendaForm.participantIds.includes(u.userId);
                  const online = onlineUserIds.has(u.userId);
                  return (
                    <label
                      key={u.userId}
                      // "busy" (opacidade reduzida + cursor de
                      // bloqueado, ver globals.css) só representa
                      // quem NÃO dá pra adicionar -- já selecionado
                      // continua podendo ser removido (ver disabled
                      // do checkbox abaixo), então não faz sentido
                      // parecer travado nesse caso.
                      className={busy && !selected ? "chat-picker-item busy" : "chat-picker-item"}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        // 2/out, bug do Douglas: "travou em alguem [...]
                        // fica dando isso mesmo que eu tire a selecao"
                        // -- indisponível só trava ADICIONAR; já
                        // selecionado (foi assim que virou indisponível
                        // -- ver comentário grande de
                        // toggleAgendaParticipant/usePlatformChat.ts)
                        // sempre pode ser removido, senão o formulário
                        // ficava travado nesse erro pra sempre.
                        disabled={busy && !selected}
                        onChange={() => onToggleAgendaParticipant(u.userId)}
                      />
                      <span className="chat-conv-avatar" style={{ background: u.color }}>
                        {(u.name || "?").slice(0, 1).toUpperCase()}
                      </span>
                      <span>{u.name || "Sem nome"}</span>
                      {online && <span className="agenda-online-dot" title="Online agora" />}
                      {busy && <span className="agenda-badge busy">Indisponível</span>}
                    </label>
                  );
                })}
              </div>
            )}
              </>
            )}

            {agendaError && <p className="agenda-error">{agendaError}</p>}

            <button className="chat-primary-btn" disabled={!agendaForm.date || !agendaForm.time} onClick={onSubmitCreateCall}>
              {editingCallId ? "Salvar alterações" : "Marcar compromisso"}
            </button>
          </div>
        </>
      )}

      {agendaView === "detail" && detailCall && (
        <>
          <div className="chat-drawer-header">
            <button
              className="chat-icon-btn"
              title="Voltar"
              onClick={() => onChangeAgendaView(agendaColleagueId ? "colleague" : "list")}
            >
              <BackIcon />
            </button>
            <h3>{detailCall.title}</h3>
            <div className="chat-drawer-header-actions">
              <button className="chat-icon-btn" title="Fechar" onClick={onClose}>
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="agenda-detail-body">
            <p className="agenda-detail-when">
              {formatCallDateTime(detailCall.startTs)} · {detailCall.durationMinutes}min
            </p>
            <p className="agenda-detail-creator">
              Marcado por {detailCall.createdByName || "?"} ·{" "}
              {detailCall.visibility === "private" ? "🔒 Privado" : "Público"} ·{" "}
              {detailCall.blocksAgenda === false ? "não trava agenda" : "trava agenda"}
            </p>
            {detailCall.description && <p className="agenda-detail-description">{detailCall.description}</p>}
            <div className="agenda-needs-row">
              {detailCall.needs.camera && (
                <span className="agenda-need-pill">
                  <CamIcon off={false} /> Câmera
                </span>
              )}
              {detailCall.needs.audio && (
                <span className="agenda-need-pill">
                  <MicIcon off={false} /> Áudio
                </span>
              )}
              {detailCall.needs.screen && (
                <span className="agenda-need-pill">
                  <ScreenIcon active={false} /> Tela
                </span>
              )}
            </div>
            {(detailCall.attachments.length > 0 || myCallStatus !== null) && (
              <div className="agenda-attachment-field">
                <span className="agenda-field-label">Anexos</span>
                {detailCall.attachments.length > 0 ? (
                  <div className="agenda-attachment-list">
                    {detailCall.attachments.map((a, i) => (
                      <a
                        key={`${a.url}-${i}`}
                        className="chat-attachment-file"
                        href={attachmentUrl(a.url)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <FileIcon />
                        <span className="chat-attachment-file-info">
                          <span className="chat-attachment-file-name">{a.name}</span>
                          <span className="chat-attachment-file-size">{formatFileSize(a.size)}</span>
                        </span>
                      </a>
                    ))}
                  </div>
                ) : (
                  <p className="chat-empty-hint agenda-day-group-empty">Nenhum anexo ainda.</p>
                )}
                {myCallStatus !== null && (
                  <button
                    type="button"
                    className="chat-secondary-btn"
                    onClick={onPickDetailAttachment}
                    disabled={sendingDetailAttachment}
                  >
                    {sendingDetailAttachment ? "Enviando..." : "+ Anexar arquivo"}
                  </button>
                )}
              </div>
            )}
            <span className="agenda-field-label">Participantes</span>
            <div className="agenda-participant-list">
              {detailCall.participants.map((p) => (
                <div key={p.id} className="agenda-participant-row">
                  <span className="chat-conv-avatar" style={{ background: p.color }}>
                    {(p.name || "?").slice(0, 1).toUpperCase()}
                  </span>
                  <span className="agenda-participant-name">{p.id === myUserId ? "Você" : p.name || "Sem nome"}</span>
                  <span className={`agenda-badge ${p.status}`}>
                    {p.status === "approved" ? "Confirmado" : p.status === "declined" ? "Recusou" : "Aguardando"}
                  </span>
                </div>
              ))}
            </div>
            {myCallStatus === "pending" && (
              <div className="agenda-respond-row">
                <button className="chat-primary-btn" onClick={() => onRespondToCall(detailCall.id, "approved")}>
                  Confirmar presença
                </button>
                <button className="chat-secondary-btn" onClick={() => onRespondToCall(detailCall.id, "declined")}>
                  Recusar
                </button>
              </div>
            )}
            {/* editar/apagar (2/out) -- só quem CRIOU o compromisso
                (mesma trava do servidor, ver handleAgendaUpdate/
                handleAgendaDelete em server/index.js). Migrado do
                LobbyAgendaPanel antigo (só existia fora da sala, REST)
                pro protocolo único -- agora funciona dos dois lados. */}
            {detailCall.createdBy === myUserId && (
              <div className="agenda-respond-row">
                <button className="chat-secondary-btn" onClick={() => onEditCall(detailCall)}>
                  Editar
                </button>
                <button
                  className="chat-secondary-btn"
                  onClick={() => {
                    if (window.confirm("Apagar esse compromisso?")) onDeleteCall(detailCall.id);
                  }}
                >
                  Apagar
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
