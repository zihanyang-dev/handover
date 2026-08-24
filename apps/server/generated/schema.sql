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
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS '';


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
    CONSTRAINT agents_kind_check CHECK ((kind = ANY (ARRAY['claude-code'::text, 'codex'::text, 'cursor-agent'::text])))
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
    CONSTRAINT email_codes_closed_reason_check CHECK ((closed_reason = ANY (ARRAY['consumed'::text, 'superseded'::text]))),
    CONSTRAINT email_codes_closed_together CHECK (((closed_at IS NULL) = (closed_reason IS NULL))),
    CONSTRAINT email_codes_purpose_check CHECK ((purpose = ANY (ARRAY['sign-in'::text, 'attach'::text])))
);


--
-- Name: enrolments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrolments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    space_id uuid,
    machine_name text NOT NULL,
    secret_hash text NOT NULL,
    user_code text,
    approved_by uuid,
    approved_at timestamp with time zone,
    refused_at timestamp with time zone,
    claimed_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT enrolments_approved_into_a_space CHECK (((approved_at IS NULL) OR (space_id IS NOT NULL))),
    CONSTRAINT enrolments_approved_together CHECK (((approved_at IS NULL) = (approved_by IS NULL))),
    CONSTRAINT enrolments_claimed_after_approval CHECK (((claimed_at IS NULL) OR (approved_at IS NOT NULL))),
    CONSTRAINT enrolments_not_both_answers CHECK (((refused_at IS NULL) OR (approved_at IS NULL)))
);


--
-- Name: machines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.machines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    space_id uuid NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    enrolled_from uuid NOT NULL,
    last_seen_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    left_at timestamp with time zone,
    removed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memberships (
    space_id uuid NOT NULL,
    user_id uuid NOT NULL,
    request_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
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
-- Name: email_codes email_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_codes
    ADD CONSTRAINT email_codes_pkey PRIMARY KEY (id);


--
-- Name: email_codes email_codes_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_codes
    ADD CONSTRAINT email_codes_request_key_key UNIQUE (request_key);


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
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (space_id, user_id);


--
-- Name: memberships memberships_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_request_key_key UNIQUE (request_key);


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
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: credentials_one_provider_account_each; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX credentials_one_provider_account_each ON public.credentials USING btree (user_id, kind) WHERE (kind <> 'email'::text);


--
-- Name: email_codes_live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX email_codes_live ON public.email_codes USING btree (email, purpose) WHERE (closed_at IS NULL);


--
-- Name: enrolments_waiting_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX enrolments_waiting_code ON public.enrolments USING btree (user_code) WHERE ((claimed_at IS NULL) AND (refused_at IS NULL));


--
-- Name: machines_in_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX machines_in_space ON public.machines USING btree (space_id) WHERE (removed_at IS NULL);


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
-- Name: enrolments enrolments_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrolments
    ADD CONSTRAINT enrolments_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id);


--
-- Name: machines machines_enrolled_from_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machines
    ADD CONSTRAINT machines_enrolled_from_fkey FOREIGN KEY (enrolled_from) REFERENCES public.enrolments(id);


--
-- Name: machines machines_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machines
    ADD CONSTRAINT machines_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id);


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
-- PostgreSQL database dump complete
--

\unrestrict handover

