--
-- PostgreSQL database dump
--

\restrict handover

-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: a_space_keeps_an_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.a_space_keeps_an_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (
    select 1 from memberships
     where space_id = coalesce(new.space_id, old.space_id)
       and role = 'owner'
       and revoked_at is null
  ) then
    raise exception 'a Space must have at least one owner'
      using errcode = 'check_violation', constraint = 'memberships_keep_an_owner';
  end if;

  return null;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    machine_id uuid NOT NULL,
    kind text NOT NULL,
    version text NOT NULL,
    found_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    models jsonb,
    CONSTRAINT agents_kind_check CHECK ((kind = ANY (ARRAY['claude-code'::text, 'codex'::text])))
);


--
-- Name: browser_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    space_id uuid NOT NULL,
    machine_id uuid NOT NULL,
    agent_kind text NOT NULL,
    agent_session_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credentials (
    user_id uuid NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    verified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT credentials_kind_check CHECK ((kind = ANY (ARRAY['email'::text, 'google'::text, 'github'::text])))
);


--
-- Name: email_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    purpose text NOT NULL,
    code_hash text NOT NULL,
    request_key text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    closed_reason text,
    delivery text,
    asked_by text,
    CONSTRAINT email_codes_closed_reason_check CHECK ((closed_reason = ANY (ARRAY['consumed'::text, 'superseded'::text]))),
    CONSTRAINT email_codes_closed_together CHECK (((closed_at IS NULL) = (closed_reason IS NULL))),
    CONSTRAINT email_codes_delivery_check CHECK ((delivery = ANY (ARRAY['sent'::text, 'refused'::text, 'unknown'::text]))),
    CONSTRAINT email_codes_purpose_check CHECK ((purpose = ANY (ARRAY['sign-in'::text, 'attach'::text])))
);


--
-- Name: enrolments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrolments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    machine_name text,
    secret_hash text NOT NULL,
    user_code text,
    approved_by uuid,
    approved_at timestamp with time zone,
    refused_at timestamp with time zone,
    claimed_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT enrolments_approved_together CHECK (((approved_at IS NULL) = (approved_by IS NULL))),
    CONSTRAINT enrolments_claimed_after_approval CHECK (((claimed_at IS NULL) OR (approved_at IS NOT NULL))),
    CONSTRAINT enrolments_not_both_answers CHECK (((refused_at IS NULL) OR (approved_at IS NULL)))
);


--
-- Name: invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    space_id uuid NOT NULL,
    secret_hash text NOT NULL,
    made_by uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: machines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.machines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    enrolled_from uuid NOT NULL,
    last_seen_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    left_at timestamp with time zone,
    removed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    version text,
    owner_user_id uuid NOT NULL
);


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memberships (
    space_id uuid NOT NULL,
    user_id uuid NOT NULL,
    request_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT memberships_role_known CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text])))
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    seq integer NOT NULL,
    key text NOT NULL,
    role text NOT NULL,
    content jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'tool'::text, 'activity'::text])))
);


--
-- Name: outputs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outputs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outputs_body_check CHECK (((btrim(body) <> ''::text) AND (octet_length(body) <= 65536))),
    CONSTRAINT outputs_title_check CHECK (((btrim(title) <> ''::text) AND (octet_length(title) <= 200)))
);


--
-- Name: spaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    display_name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    parent_id uuid,
    owner_user_id uuid NOT NULL,
    goal text NOT NULL,
    state text NOT NULL,
    sleep_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT tasks_check CHECK (((ended_at IS NULL) = (state <> 'done'::text))),
    CONSTRAINT tasks_check1 CHECK (((sleep_until IS NULL) = (state <> 'sleep'::text))),
    CONSTRAINT tasks_goal_check CHECK (((btrim(goal) <> ''::text) AND (octet_length(goal) <= 2000))),
    CONSTRAINT tasks_state_check CHECK ((state = ANY (ARRAY['working'::text, 'wait'::text, 'sleep'::text, 'done'::text])))
);


--
-- Name: turns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.turns (
    conversation_id uuid NOT NULL,
    after_seq integer NOT NULL,
    machine_id uuid NOT NULL,
    claimed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    ended_at timestamp with time zone
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (machine_id, kind);


--
-- Name: browser_sessions browser_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_pkey PRIMARY KEY (id);


--
-- Name: browser_sessions browser_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: conversations conversations_id_machine_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_id_machine_id_key UNIQUE (id, machine_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: credentials credentials_kind_subject_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credentials
    ADD CONSTRAINT credentials_kind_subject_key UNIQUE (kind, subject);


--
-- Name: credentials credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credentials
    ADD CONSTRAINT credentials_pkey PRIMARY KEY (user_id, kind, subject);


--
-- Name: email_codes email_codes_asked_once; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_codes
    ADD CONSTRAINT email_codes_asked_once UNIQUE (request_key, email, purpose);


--
-- Name: email_codes email_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_codes
    ADD CONSTRAINT email_codes_pkey PRIMARY KEY (id);


--
-- Name: enrolments enrolments_id_approved_by_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrolments
    ADD CONSTRAINT enrolments_id_approved_by_key UNIQUE (id, approved_by);


--
-- Name: enrolments enrolments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrolments
    ADD CONSTRAINT enrolments_pkey PRIMARY KEY (id);


--
-- Name: enrolments enrolments_secret_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrolments
    ADD CONSTRAINT enrolments_secret_hash_key UNIQUE (secret_hash);


--
-- Name: enrolments enrolments_user_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrolments
    ADD CONSTRAINT enrolments_user_code_key UNIQUE (user_code);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_secret_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_secret_hash_key UNIQUE (secret_hash);


--
-- Name: machines machines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machines
    ADD CONSTRAINT machines_pkey PRIMARY KEY (id);


--
-- Name: machines machines_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machines
    ADD CONSTRAINT machines_token_hash_key UNIQUE (token_hash);


--
-- Name: memberships memberships_asked_once; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_asked_once UNIQUE (user_id, request_key);


--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (space_id, user_id);


--
-- Name: messages messages_in_order; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_in_order UNIQUE (conversation_id, seq);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: messages messages_said_once; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_said_once UNIQUE (conversation_id, key);


--
-- Name: outputs outputs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outputs
    ADD CONSTRAINT outputs_pkey PRIMARY KEY (id);


--
-- Name: outputs outputs_task_id_title_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outputs
    ADD CONSTRAINT outputs_task_id_title_key UNIQUE (task_id, title);


--
-- Name: spaces spaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spaces
    ADD CONSTRAINT spaces_pkey PRIMARY KEY (id);


--
-- Name: spaces spaces_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spaces
    ADD CONSTRAINT spaces_slug_key UNIQUE (slug);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: turns turns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_pkey PRIMARY KEY (conversation_id, after_seq);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: conversations_in_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_in_space ON public.conversations USING btree (space_id, created_at DESC);


--
-- Name: conversations_on_machine; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_on_machine ON public.conversations USING btree (machine_id);


--
-- Name: credentials_one_provider_account_each; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX credentials_one_provider_account_each ON public.credentials USING btree (user_id, kind) WHERE (kind <> 'email'::text);


--
-- Name: email_codes_asked_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_codes_asked_by ON public.email_codes USING btree (asked_by, created_at) WHERE (asked_by IS NOT NULL);


--
-- Name: email_codes_live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX email_codes_live ON public.email_codes USING btree (email, purpose) WHERE (closed_at IS NULL);


--
-- Name: enrolments_waiting_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX enrolments_waiting_code ON public.enrolments USING btree (user_code) WHERE ((claimed_at IS NULL) AND (refused_at IS NULL));


--
-- Name: invitations_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitations_open ON public.invitations USING btree (space_id) WHERE (revoked_at IS NULL);


--
-- Name: machines_of_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX machines_of_owner ON public.machines USING btree (owner_user_id) WHERE (removed_at IS NULL);


--
-- Name: memberships_here; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memberships_here ON public.memberships USING btree (space_id, user_id) WHERE (revoked_at IS NULL);


--
-- Name: messages_asked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_asked ON public.messages USING btree (conversation_id, seq) WHERE (role = 'user'::text);


--
-- Name: tasks_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_due ON public.tasks USING btree (sleep_until) WHERE (state = 'sleep'::text);


--
-- Name: tasks_one_open_per_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tasks_one_open_per_conversation ON public.tasks USING btree (conversation_id) WHERE (ended_at IS NULL);


--
-- Name: tasks_open_children; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_open_children ON public.tasks USING btree (parent_id) WHERE (ended_at IS NULL);


--
-- Name: tasks_waiting_on_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_waiting_on_owner ON public.tasks USING btree (owner_user_id) WHERE ((state = 'wait'::text) AND (parent_id IS NULL));


--
-- Name: turns_one_open_per_machine; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX turns_one_open_per_machine ON public.turns USING btree (machine_id) WHERE (ended_at IS NULL);


--
-- Name: memberships memberships_keep_an_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER memberships_keep_an_owner AFTER INSERT OR DELETE OR UPDATE ON public.memberships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.a_space_keeps_an_owner();


--
-- Name: agents agents_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.machines(id) ON DELETE CASCADE;


--
-- Name: browser_sessions browser_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: conversations conversations_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.machines(id);


--
-- Name: conversations conversations_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id);


--
-- Name: credentials credentials_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credentials
    ADD CONSTRAINT credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: enrolments enrolments_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrolments
    ADD CONSTRAINT enrolments_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: invitations invitations_made_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_made_by_fkey FOREIGN KEY (made_by) REFERENCES public.users(id);


--
-- Name: invitations invitations_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id);


--
-- Name: machines machines_owned_by_whoever_approved_it; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machines
    ADD CONSTRAINT machines_owned_by_whoever_approved_it FOREIGN KEY (enrolled_from, owner_user_id) REFERENCES public.enrolments(id, approved_by);


--
-- Name: machines machines_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machines
    ADD CONSTRAINT machines_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);


--
-- Name: memberships memberships_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id);


--
-- Name: memberships memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: outputs outputs_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outputs
    ADD CONSTRAINT outputs_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);


--
-- Name: tasks tasks_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.tasks(id);


--
-- Name: turns turns_conversation_id_asked_seq_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_conversation_id_asked_seq_fkey FOREIGN KEY (conversation_id, after_seq) REFERENCES public.messages(conversation_id, seq) ON DELETE CASCADE;


--
-- Name: turns turns_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: turns turns_on_its_conversations_machine; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_on_its_conversations_machine FOREIGN KEY (conversation_id, machine_id) REFERENCES public.conversations(id, machine_id);


--
-- PostgreSQL database dump complete
--

\unrestrict handover

