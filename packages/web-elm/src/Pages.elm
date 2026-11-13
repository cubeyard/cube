module Pages exposing (artifact, artifacts, history, projects, runnerCard, runners, settings)

import Data exposing (..)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Json.Decode as D
import Json.Encode as E
import Model exposing (..)
import Phase
import Ui exposing (..)


confirm : String -> String -> String -> Cmd Msg -> Msg
confirm title_ body label cmd =
    Open (Confirm { title = title_, body = body, label = label, run = Do label cmd })


post : String -> String -> Cmd Msg
post url done =
    send "POST" url (E.object []) (D.succeed ()) (Did done)



-- ARTIFACTS


artifacts : Model -> Html Msg
artifacts model =
    div [ class "page" ]
        [ header [ class "page-head" ]
            [ div []
                [ h1 [] [ text "artifacts" ]
                , p [ class "muted" ] [ text "documents agents wrote for you: plans, reviews, reports. you read them, comment on the text and confirm their actions." ]
                ]
            ]
        , remoteView model.artifacts "artifacts" <|
            \items ->
                let
                    shown =
                        items |> List.filter (\item -> model.projectFilter == Nothing || item.projectId == model.projectFilter) |> List.sortBy (\item -> negate item.updatedAt)
                in
                if List.isEmpty shown then
                    empty "no artifacts yet. an agent writes one when a result deserves a document."

                else
                    div [ class "rows" ]
                        (List.map
                            (\item ->
                                a [ href ("#/a/" ++ item.id), class "row plain" ]
                                    [ div [ class "row-main" ]
                                        [ div [ class "row-top" ]
                                            [ strong [] [ text item.title ]
                                            , span [ class "pill quiet" ] [ text ("revision " ++ String.fromInt item.head) ]
                                            , if item.comments.draft > 0 then
                                                span [ class "pill needs" ] [ text (String.fromInt item.comments.draft ++ " unsent comments") ]

                                              else
                                                text ""
                                            , if item.comments.undeliverable > 0 then
                                                span [ class "pill failed" ] [ text (String.fromInt item.comments.undeliverable ++ " undeliverable") ]

                                              else
                                                text ""
                                            ]
                                        , div [ class "row-meta" ]
                                            [ span [ class "tag" ] [ text (Maybe.withDefault "no project" item.projectName) ]
                                            , span [] [ text ("by " ++ (item.threadTitle |> Maybe.withDefault item.authorKind)) ]
                                            , span [] [ text ("updated " ++ ago model.now item.updatedAt) ]
                                            ]
                                        ]
                                    ]
                            )
                            shown
                        )
        ]


artifact : Model -> Html Msg
artifact model =
    case model.artifact of
        Nothing ->
            text ""

        Just state ->
            div [ class "page artifact-page" ]
                [ remoteView state.view "the artifact" <|
                    \known ->
                        let
                            drafts =
                                List.filter (\c -> c.state == "draft") known.comments

                            shown =
                                Maybe.withDefault known.item.head state.shown
                        in
                        div []
                            [ header [ class "page-head" ]
                                [ div []
                                    [ p [ class "muted" ] [ a [ href "#/artifacts" ] [ text "artifacts" ], text " /" ]
                                    , h1 [] [ text known.item.title ]
                                    , p [ class "muted where" ]
                                        [ span [ class "tag" ] [ text (Maybe.withDefault "no project" known.item.projectName) ]
                                        , text " written by "
                                        , case known.item.threadId of
                                            Just id ->
                                                a [ href ("#/t/" ++ id) ] [ text (Maybe.withDefault (shortId id) known.item.threadTitle) ]

                                            Nothing ->
                                                text known.item.authorKind
                                        ]
                                    ]
                                , div [ class "head-actions" ]
                                    [ label [ class "inline" ]
                                        [ text "revision "
                                        , select [ onInput (String.toInt >> Maybe.withDefault shown >> ShowRevision) ]
                                            (List.map (\r -> option [ value (String.fromInt r.number), selected (r.number == shown) ] [ text (String.fromInt r.number ++ " · " ++ ago model.now r.createdAt) ]) (List.reverse known.revisions))
                                        ]
                                    ]
                                ]
                            , if shown /= known.item.head then
                                p [ class "note" ] [ text ("you are reading revision " ++ String.fromInt shown ++ "; the newest is " ++ String.fromInt known.item.head ++ ". only the newest revision's actions run.") ]

                              else
                                text ""
                            , div [ class "artifact-grid" ]
                                [ div []
                                    [ remoteView state.revision "the revision" <|
                                        \rev ->
                                            div []
                                                [ if List.isEmpty rev.actions then
                                                    text ""

                                                  else
                                                    div [ class "actions" ]
                                                        (List.map
                                                            (\act ->
                                                                button [ class "primary", onClick (Open (RunAction { action = act, preview = Nothing, typed = "", busy = False, result = Nothing })) ] [ text act.label ]
                                                            )
                                                            rev.actions
                                                        )
                                                , article [ id "artifact-body", class "doc" ] [ markdown rev.body ]
                                                ]
                                    ]
                                , aside [ class "comments", attribute "aria-label" "comments" ]
                                    [ h2 [] [ text "comments" ]
                                    , case state.selection of
                                        Nothing ->
                                            p [ class "muted" ] [ text "select text in the document to comment on it." ]

                                        Just selected ->
                                            div [ class "new-comment" ]
                                                [ blockquote [] [ text selected.quote ]
                                                , textarea [ rows 3, value state.body, onInput CommentBody, placeholder "your comment", attribute "aria-label" "comment" ] []
                                                , button [ class "primary", onClick AddComment, disabled (state.busy || String.isEmpty (String.trim state.body)) ] [ text "add as draft" ]
                                                ]
                                    , if List.isEmpty drafts then
                                        text ""

                                      else
                                        button
                                            [ class "primary"
                                            , onClick (Do "send" (send "POST" ("/api/artifacts/" ++ state.id ++ "/send") (E.object [ ( "requestId", E.string ("elm-send-" ++ String.fromInt model.now) ) ]) (D.succeed ()) (Did "comments sent to the author")))
                                            ]
                                            [ text ("send " ++ String.fromInt (List.length drafts) ++ " to the author") ]
                                    , if List.isEmpty known.comments then
                                        empty "no comments."

                                      else
                                        div []
                                            (List.map
                                                (\c ->
                                                    div [ class ("comment " ++ c.state) ]
                                                        [ blockquote [] [ text c.anchor.quote ]
                                                        , p [] [ text c.body ]
                                                        , p [ class "muted" ]
                                                            [ text (c.state ++ " · on revision " ++ String.fromInt c.revision ++ (c.note |> Maybe.map (\n -> " · " ++ n) |> Maybe.withDefault ""))
                                                            , if c.state == "draft" then
                                                                button [ class "quiet-button", onClick (Do "delete" (send "DELETE" ("/api/artifacts/" ++ state.id ++ "/comments/" ++ c.id) (E.object []) (D.succeed ()) (Did "draft deleted"))) ] [ text "delete" ]

                                                              else
                                                                text ""
                                                            ]
                                                        ]
                                                )
                                                known.comments
                                            )
                                    , if List.isEmpty known.runs then
                                        text ""

                                      else
                                        div []
                                            (h2 [] [ text "action runs" ]
                                                :: List.map (\run -> p [ class ("comment " ++ run.state) ] [ text (run.action ++ " on revision " ++ String.fromInt run.revision ++ ": " ++ run.state ++ " · " ++ run.detail) ]) known.runs
                                            )
                                    ]
                                ]
                            ]
                ]



-- PROJECTS


projects : Model -> Html Msg
projects model =
    div [ class "page" ]
        [ header [ class "page-head" ]
            [ div []
                [ h1 [] [ text "projects" ]
                , p [ class "muted" ] [ text "a project is the repositories a thread's machine checks out. every thread belongs to one." ]
                ]
            , div [ class "head-actions" ] [ button [ class "primary", onClick (Open (NewProject { name = "", url = "", base = "", busy = False, error = Nothing })) ] [ text "new project" ] ]
            ]
        , remoteView model.projects "projects" <|
            \items ->
                if List.isEmpty items then
                    empty "no projects yet. add one to start threads."

                else
                    div [ class "cards" ]
                        (List.map
                            (\item ->
                                let
                                    open =
                                        loaded model.threads |> List.filter (\t -> t.projectId == item.id && not t.archived)

                                    working =
                                        open |> List.filter (\t -> Phase.group (phaseOf model t) == Phase.Running) |> List.length
                                in
                                div [ class "card", attribute "data-project" item.name ]
                                    [ div [ class "row-top" ]
                                        [ h2 [] [ text item.name ]
                                        , span
                                            [ class
                                                ("pill "
                                                    ++ (if item.status == "ready" then
                                                            "done"

                                                        else if item.status == "checking" then
                                                            "preparing"

                                                        else
                                                            "failed"
                                                       )
                                                )
                                            ]
                                            [ text item.status ]
                                        ]
                                    , case item.error of
                                        Just why ->
                                            p [ class "problem" ] [ text why ]

                                        Nothing ->
                                            text ""
                                    , ul [ class "repos" ]
                                        (List.map
                                            (\repo ->
                                                li []
                                                    [ code [] [ text repo.url ]
                                                    , span [ class "muted" ] [ text (" · " ++ Maybe.withDefault "default branch" repo.resolvedBase ++ (repo.baseOid |> Maybe.map (\oid -> " @ " ++ String.left 10 oid) |> Maybe.withDefault "") ++ " · " ++ repo.status) ]
                                                    , case repo.error of
                                                        Just why ->
                                                            span [ class "problem" ] [ text (" " ++ why) ]

                                                        Nothing ->
                                                            text ""
                                                    ]
                                            )
                                            item.repositories
                                        )
                                    , p [ class "muted" ]
                                        [ text
                                            (String.fromInt (List.length open)
                                                ++ " open threads · "
                                                ++ String.fromInt working
                                                ++ " working · hooks: "
                                                ++ (if String.isEmpty item.preSetup && String.isEmpty item.preResume then
                                                        "none"

                                                    else
                                                        "set"
                                                   )
                                                ++ (case ( item.vcpus, item.memoryMiB ) of
                                                        ( Just cpus, Just mem ) ->
                                                            " · machines default to " ++ String.fromInt cpus ++ " vcpu, " ++ String.fromInt mem ++ " MiB"

                                                        _ ->
                                                            ""
                                                   )
                                            )
                                        ]
                                    , div [ class "card-actions" ]
                                        [ button [ class "primary", onClick (Open (NewThread { projectId = item.id, text = "", busy = False, error = Nothing })), disabled (item.status /= "ready") ] [ text "new thread" ]
                                        , a [ class "button-link", href "#/", onClick (SetProjectFilter (Just item.id)) ] [ text "its threads" ]
                                        , button [ class "quiet-button", onClick (Do "check" (post ("/api/projects/" ++ item.id ++ "/check") ("checked " ++ item.name))) ] [ text "check again" ]
                                        , button
                                            [ class "quiet-button"
                                            , onClick (confirm ("delete project " ++ item.name ++ "?") "cubed refuses while the project still has threads. this cannot be undone." "delete" (send "DELETE" ("/api/projects/" ++ item.id) (E.object []) (D.succeed ()) (Did ("project " ++ item.name ++ " deleted"))))
                                            ]
                                            [ text "delete" ]
                                        ]
                                    ]
                            )
                            items
                        )
        ]



-- RUNNERS


runnerCard : Model -> Bool -> Runner -> Html Msg
runnerCard model compact item =
    let
        hosted =
            loaded model.threads |> List.filter (\t -> t.runnerId == Just item.id && not t.archived)

        reachable =
            item.contact == "reachable"

        contactWords =
            case ( item.contact, item.lastContactAt, item.unreachableSince ) of
                ( "reachable", Just at, _ ) ->
                    "reachable · answered " ++ ago model.now at

                ( "unreachable", last, Just since ) ->
                    "unreachable for " ++ duration (model.now - since) ++ (last |> Maybe.map (\at -> " · last answered " ++ ago model.now at) |> Maybe.withDefault "")

                ( "unknown", _, _ ) ->
                    "never answered a probe"

                ( other, _, _ ) ->
                    other

        taken =
            item.slotsTotal - item.slotsFree
    in
    div [ class "card runner", classList [ ( "stale", item.contact == "unreachable" ) ], attribute "data-runner" item.nodeId ]
        [ div [ class "row-top" ]
            [ h3 [] [ text item.nodeId ]
            , span
                [ class
                    ("pill "
                        ++ (if reachable then
                                "done"

                            else if item.contact == "unknown" then
                                "quiet"

                            else
                                "failed"
                           )
                    )
                ]
                [ text item.contact ]
            , if item.protocol /= 4 then
                span [ class "pill quiet" ] [ text "retired protocol 3" ]

              else if item.byName then
                span [ class "pill quiet" ] [ text "by name only" ]

              else
                text ""
            ]
        , p [ class "muted" ] [ text contactWords ]
        , if item.contact == "unreachable" then
            p [ class "muted" ] [ text ("its " ++ String.fromInt item.slotsTotal ++ " slots count as taken while it does not answer.") ]

          else
            div [ class "slots", title (String.fromInt taken ++ " of " ++ String.fromInt item.slotsTotal ++ " slots taken") ]
                (List.repeat taken (span [ class "slot taken" ] []) ++ List.repeat item.slotsFree (span [ class "slot" ] []) ++ [ span [ class "muted" ] [ text (String.fromInt item.slotsFree ++ " of " ++ String.fromInt item.slotsTotal ++ " free") ] ])
        , if not reachable && not (List.isEmpty hosted) then
            p [ class "problem" ] [ text "the states of its threads below are what cubed last knew; it cannot see them now." ]

          else
            text ""
        , if List.isEmpty hosted then
            p [ class "muted" ] [ text "hosts no open thread." ]

          else
            ul [ class "hosted" ]
                (List.map
                    (\t ->
                        let
                            value =
                                phaseOf model t
                        in
                        li [] [ glyph value, div [] [ a [ href ("#/t/" ++ t.id) ] [ text (threadLabel t) ], div [ class "muted" ] [ text (Phase.label value) ] ] ]
                    )
                    hosted
                )
        , if compact then
            text ""

          else
            div []
                [ case item.report of
                    Just report ->
                        p [ class "muted" ]
                            [ text
                                ("berth " ++ report.version ++ " · " ++ Maybe.withDefault "platform unknown" report.platform ++ " · " ++ report.lifecycle
                                    ++ (if report.draining then " · draining" else "")
                                    ++ " · " ++ String.fromInt report.runningVms ++ " running, " ++ String.fromInt report.activeVms ++ " active, " ++ String.fromInt report.retainedVms ++ " retained disks · report "
                                    ++ (if report.fresh then "current" else "stale, " ++ duration report.ageMs ++ " old")
                                )
                            ]

                    Nothing ->
                        p [ class "muted" ] [ text "it has sent no report." ]
                , case item.contactError of
                    Just why ->
                        p [ class "problem" ] [ text why ]

                    Nothing ->
                        text ""
                , if List.isEmpty item.unknown then
                    text ""

                  else
                    details [] [ summary [] [ text "what cubed does not know" ], ul [] (List.map (\words -> li [] [ text words ]) item.unknown) ]
                , div [ class "card-actions" ]
                    [ button [ class "quiet-button", onClick (Do "check" (post ("/api/runners/" ++ item.id ++ "/check") ("probed " ++ item.nodeId))) ] [ text "probe now" ] ]
                ]
        ]


runners : Model -> Html Msg
runners model =
    div [ class "page" ]
        [ header [ class "page-head" ]
            [ div []
                [ h1 [] [ text "runners" ]
                , p [ class "muted" ] [ text "the hosts that run thread machines. a thread keeps its runner; a full runner makes new and waking threads wait." ]
                ]
            ]
        , remoteView model.runners "runners" <|
            \known ->
                div []
                    [ p [ class "summary" ] [ text (String.fromInt known.free ++ " of " ++ String.fromInt known.slots ++ " pooled machine slots free · " ++ String.fromInt known.reserved ++ " reserved · observed " ++ ago model.now known.observedAt) ]
                    , if List.isEmpty known.runners then
                        empty "no runner is enrolled, so no thread can start."

                      else
                        div [ class "cards" ] (List.map (runnerCard model False) known.runners)
                    , if List.isEmpty known.notReported then
                        text ""

                      else
                        details [] [ summary [] [ text "what no runner reports" ], ul [] (List.map (\words -> li [] [ text words ]) known.notReported) ]
                    , p [ class "muted" ] [ text "retiring a runner is not offered in this preview." ]
                    ]
        ]



-- HISTORY


history : Model -> Html Msg
history model =
    let
        wanted =
            String.toLower (String.trim model.search)

        matches t =
            String.isEmpty wanted || String.contains wanted (String.toLower (threadLabel t ++ " " ++ Maybe.withDefault "" t.name ++ " " ++ t.projectName ++ " " ++ t.id))
    in
    div [ class "page" ]
        [ header [ class "page-head" ]
            [ div []
                [ h1 [] [ text "history" ]
                , p [ class "muted" ] [ text "archived threads. their conversations stay in cubed, but its api does not serve an archived transcript to the browser: ask optchat, which can read and search them." ]
                ]
            ]
        , input [ id "search", type_ "search", placeholder "filter by title, name, project or id", value model.search, onInput SetSearch, attribute "aria-label" "filter archived threads" ] []
        , remoteView model.archived "archived threads" <|
            \items ->
                let
                    shown =
                        items |> List.filter matches |> List.sortBy (\t -> negate t.createdAt)
                in
                if List.isEmpty items then
                    empty "nothing is archived yet."

                else if List.isEmpty shown then
                    empty ("no archived thread matches “" ++ model.search ++ "”.")

                else
                    div [ class "rows" ]
                        (List.map
                            (\t ->
                                div [ class "row plain" ]
                                    [ div [ class "row-main" ]
                                        [ div [ class "row-top" ]
                                            [ strong [] [ text (threadLabel t) ]
                                            , span [ class "pill quiet" ] [ text "archived" ]
                                            , if t.retain == Just True && not t.discarded then
                                                span [ class "pill needs" ] [ text "disk kept" ]

                                              else
                                                text ""
                                            ]
                                        , if t.retain == Just True && not t.discarded then
                                            div [ class "row-doing" ]
                                                [ text (Maybe.withDefault "its disk was kept" t.retainReason ++ " ")
                                                , button
                                                    [ class "quiet-button"
                                                    , onClick (confirm "discard the kept disk?" "whatever was uncommitted or unpushed on this thread's disk is deleted for good." "discard disk" (post (threadBase t.id ++ "/discard") "disk discarded"))
                                                    ]
                                                    [ text "discard disk" ]
                                                ]

                                          else
                                            text ""
                                        , div [ class "row-meta" ]
                                            [ span [ class "tag" ] [ text t.projectName ]
                                            , span [] [ text (Maybe.withDefault "" t.name) ]
                                            , span [] [ text ("started " ++ ago model.now t.createdAt) ]
                                            , code [] [ text (shortId t.id) ]
                                            , a [ href (threadBase t.id ++ "/usage"), target "_blank" ] [ text "usage (json)" ]
                                            ]
                                        ]
                                    ]
                            )
                            shown
                        )
        ]



-- SETTINGS


settings : Model -> Html Msg
settings model =
    let
        data =
            model.settings

        part title_ content =
            section [ class "card" ] (h2 [] [ text title_ ] :: content)
    in
    div [ class "page" ]
        [ header [ class "page-head" ] [ div [] [ h1 [] [ text "settings" ], p [ class "muted" ] [ text "what this cubed is, what it can reach and what it has spent. most of it is read-only in this preview." ] ] ]
        , div [ class "cards" ]
            [ part "this cubed"
                [ case model.health of
                    Just known ->
                        p [] [ text ("version " ++ known.version ++ " (" ++ known.commit ++ ") · " ++ known.lifecycle ++ " · gateway " ++ known.gateway ++ " · portal " ++ known.portal) ]

                    Nothing ->
                        p [ class "muted" ] [ text "not read yet" ]
                , remoteView data.update "the update state" <|
                    \known ->
                        div []
                            [ p [] [ text ("installed by: " ++ known.installation ++ " · update " ++ known.phase ++ (known.available |> Maybe.map (\v -> " · " ++ v ++ " is available") |> Maybe.withDefault "")) ]
                            , p [ class "muted" ] [ text (Maybe.withDefault "" known.message) ]
                            , case known.error of
                                Just why ->
                                    p [ class "problem" ] [ text why ]

                                Nothing ->
                                    text ""
                            , button [ class "quiet-button", onClick (Do "check" (send "POST" "/api/system/update" (E.object [ ( "action", E.string "check" ) ]) Data.update GotUpdate)) ] [ text "check for an update" ]
                            ]
                ]
            , part "models"
                [ remoteView data.providers "providers" <|
                    \items ->
                        ul []
                            (List.map
                                (\item ->
                                    li []
                                        [ text (item.name ++ " · ")
                                        , span [ class ("pill " ++ (if item.connected then "done" else "failed")) ] [ text (if item.connected then "connected" else "not connected") ]
                                        , if item.checkError then
                                            span [ class "problem" ] [ text " its last check failed" ]

                                          else
                                            text ""
                                        ]
                                )
                                items
                            )
                , remoteView data.settings "the model settings" <|
                    \known ->
                        div []
                            [ p [] [ text ("optchat's model: " ++ (known.chat |> Maybe.map modelName |> Maybe.withDefault "none") ++ " · memory is written by: " ++ (known.compactorModel |> Maybe.map modelName |> Maybe.withDefault "none") ++ " (" ++ known.compactorSource ++ ")") ]
                            , case known.error of
                                Just why ->
                                    p [ class "problem" ] [ text why ]

                                Nothing ->
                                    text ""
                            ]
                , p [ class "muted" ] [ text "connecting a provider (its login flow) is not built in this preview." ]
                ]
            , part "github"
                [ remoteView data.github "the github connection" <|
                    \known -> p [] [ text (known.state ++ (known.login |> Maybe.map (\l -> " as " ++ l) |> Maybe.withDefault "")) ]
                ]
            , part "skills"
                [ remoteView data.skills "skills" <|
                    \items ->
                        if List.isEmpty items then
                            empty "the next thread gets no skills from a source."

                        else
                            p [] [ text (String.join ", " items) ]
                ]
            , part "usage"
                [ remoteView data.usage "usage" <|
                    \known ->
                        div []
                            [ p [] [ text (String.fromInt known.total.tokens ++ " tokens · about $" ++ String.fromFloat (Maybe.withDefault 0 known.total.usd) ++ " estimated · coverage " ++ known.coverage) ]
                            , ul [] (List.map (\( name, spent ) -> li [] [ text (name ++ ": " ++ String.fromInt spent.tokens ++ " tokens") ]) known.projects)
                            , p [ class "muted" ] [ text (Maybe.withDefault "" known.note) ]
                            ]
                ]
            , part "optchat's memory"
                [ remoteView data.chatView "optchat's memory" <|
                    \known ->
                        div []
                            [ p [] [ text (String.fromInt known.messages ++ " messages in the chat, which optchat sees as one-line summaries.") ]
                            , case known.failure of
                                Just why ->
                                    p [ class "problem" ] [ text why ]

                                Nothing ->
                                    text ""
                            , button [ class "quiet-button", onClick ToggleMemory ] [ text (if data.memoryOpen then "hide what it sees" else "show what it sees") ]
                            , if data.memoryOpen then
                                pre [ class "step-io" ] [ text known.view ]

                              else
                                text ""
                            ]
                ]
            ]
        ]
