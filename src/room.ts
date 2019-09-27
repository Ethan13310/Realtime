// Copyright (c) 2019 Ethan Margaillan <contact@ethan.jp>.
// Licensed under the MIT Licence - https://raw.githubusercontent.com/Ethan13310/Realtime/master/LICENSE

import defaults = require('defaults');
import { EventEmitter } from 'events';
import { Client, IClientSummary } from './client';

/**
 * Représentation de la liste des clients d'un salon.
 *
 * @interface IClientList
 */

export interface IClientList
{
    /**
     * La liste des clients dans le salon.
     */
    [clientId: string]: IClientSummary
}

/**
 * Représentation d'un salon.
 *
 * @interface IRoomSummary
 */

export interface IRoomSummary
{
    /**
     * L'id du salon.
     */
    id: string;

    /**
     * L'URL publique du salon.
     */
    publicUrl: string;

    /**
     * La liste des clients dans le salon.
     */
    clients: IClientList;

    /**
     * Les propriétés de ce salon.
     */
    properties?: any;
}

/**
 * Représentation des options d'un salon.
 *
 * @interface IRoomOptions
 */

export interface IRoomOptions
{
    /**
     * L'intervalle entre les pings envoyés aux clients.
     * Si cette valeur vaut 'null' ou n'est pas définie, alors l'envoi de pings
     * aux clients est désactivé.
     */
    pingInterval?: number | null;

    /**
     * Le nombre de pings manqués avant que le client soit considéré comme
     * déconnecté. Une valeur inférieure ou égale à 1 signifie qu'aucun ping
     * ne doit être manqué sous peine que le client soit déconnecté.
     * N'a aucun effet si 'pingInterval' vaut 'null' ou n'est pas définie.
     */
    missedPingsLimit?: number;

    /**
     * Si cette valeur vaut 'true', alors les salons ne seront pas détruits
     * lorsque tous les clients l'auront quitté.
     */
    keepAlive?: boolean;
}

/**
 * Classe représentant un salon.
 *
 * @class Room
 */

export class Room extends EventEmitter
{
    /**
     * L'url publique du salon.
     */
    private readonly _publicUrl: string;

    /**
     * L'id du salon.
     */
    private readonly _id: string;

    /**
     * Les propriétés du salon.
     */
    private _properties: any;

    /**
     * Les options du salon
     */
    private readonly _options: IRoomOptions;

    /**
     * La liste des clients connectés au salon.
     */
    private readonly _clients = new Map<string, Client>();

    /**
     * La boucle d'envoi de pings aux clients.
     */
    private _pingInterval?: NodeJS.Timeout;

    /**
     * Constructeur du salon.
     *
     * @param {string} publicUrl - L'url publique du salon.
     * @param {string} id - L'id du salon.
     * @param {*} [properties] - Les propriétés du salon.
     * @param {IRoomOptions} [options] - Les options du salon.
     */

    public constructor(publicUrl: string, id: string, properties?: any, options?: IRoomOptions)
    {
        super();

        // Url publique du salon
        this._publicUrl = publicUrl;

        // Id du salon
        this._id = id;

        // Propriétés du salon
        this._properties = properties;

        // Options du salon
        this._options = defaults(options, {
            pingInterval: null,
            missedPingsLimit: 1,
            keepAlive: false
        });

        if (this._options.pingInterval)
        {
            // On ping les clients à intervalle régulier
            this._pingInterval = setInterval(() => this._pingClients(), this._options.pingInterval);
        }
    }

    /**
     * Retourne l'url publique du salon.
     *
     * @returns {string}
     */

    public get publicUrl(): string
    {
        return this._publicUrl;
    }

    /**
     * Retourne l'id du salon.
     *
     * @returns {string}
     */

    public get id(): string
    {
        return this._id;
    }

    /**
     * Retourne la liste des clients du salon, sous forme d'objet.
     *
     * @returns {IClientList}
     */

    public get clients(): IClientList
    {
        const list: IClientList = {};

        this._clients.forEach((client: Client) =>
        {
            list[client.id] = client.summary;
        });

        return list;
    }

    /**
     * Retourne les propriétés du salon.
     *
     * @returns {*}
     */

    public get properties(): any
    {
        return this._properties;
    }

    /**
     * Modifie les propriétés du salon.
     *
     * @param {*} value
     */

    public set properties(value: any)
    {
        this._properties = value;
    }

    /**
     * Retourne un résumé des informations du salon, sans les informations sur
     * les clients connectés.
     *
     * @returns {IClientSummary}
     */

    public get summary(): IRoomSummary
    {
        return {
            id: this.id,
            publicUrl: this.publicUrl,
            clients: {},
            properties: this.properties
        };
    }

    /**
     * Retourne le nombre de clients connectés au salon.
     *
     * @returns {number}
     */

    public get clientCount(): number
    {
        return this._clients.size;
    }

    /**
     * Détermine si le salon doit être maintenu lorsque tous les clients se
     * sont déconnectés.
     *
     * @returns {boolean}
     */

    public get keepAlive(): boolean
    {
        return !!this._options.keepAlive;
    }

    /**
     * Définie si le salon doit être maintenu lorsque tous les clients se sont
     * déconnectés.
     *
     * @param {boolean} value
     */

    public set keepAlive(value: boolean)
    {
        this._options.keepAlive = value;
    }

    /**
     * Détermine si le salon est vide.
     *
     * @returns {boolean}
     */

    public get isEmpty(): boolean
    {
        return this.clientCount === 0;
    }

    /**
     * Ajoute un client au salon.
     *
     * @param {Client} client - Le client à ajouter.
     */

    public join(client: Client)
    {
        if (!this.hasClient(client.id))
        {
            this._clients.set(client.id, client);

            // On notifie les listeners
            this.emit('joined', client);
        }
    }

    /**
     * Supprime un client du salon.
     *
     * @param {Client} client - Le client à supprimer.
     */

    public leave(client: Client)
    {
        if (this.hasClient(client.id))
        {
            this._clients.delete(client.id);

            // On notifie les listeners
            this.emit('left', client);

            // Puis on déconnecte le client
            client.disconnect();
        }
    }

    /**
     * Détermine si un client se trouve dans ce salon.
     *
     * @param {string} clientId - L'id du client.
     *
     * @returns {boolean}
     */

    public hasClient(clientId: string): boolean
    {
        return this._clients.has(clientId);
    }

    /**
     * Envoie un message à tous les clients du salon.
     *
     * @param {*} message - Le message à envoyer.
     */

    public send(message: any)
    {
        this._clients.forEach((client: Client) =>
        {
            client.send(message);
        });
    }

    /**
     * Envoie un message à un client.
     *
     * @param {Client} client - Le client auquel envoyer le message.
     * @param {message} message - Le message à envoyer.
     */

    public sendTo(client: Client, message: any)
    {
        if (this.hasClient(client.id))
        {
            client.send(message);
        }
    }

    /**
     * Envoie un message à tous les clients du salon, sauf celui passé en
     * paramètre.
     *
     * @param {Client} client - Le client auquel ne pas envoyer le message.
     * @param {*} message - Le message à envoyer.
     */

    public sendToOthers(client: Client, message: any)
    {
        this._clients.forEach((other: Client) =>
        {
            if (other.id !== client.id)
            {
                other.send(message);
            }
        });
    }

    /**
     * Déconnecte tous les clients et supprime le salon.
     */

    public terminate()
    {
        // On déconnecte les clients
        this._clients.forEach((client: Client) =>
        {
            client.disconnect();
        });

        // Puis on notifie les listeners
        this.emit('terminated');
    }

    /**
     * Arrête l'envoi de ping aux clients du salon.
     */

    public clearPingInterval()
    {
        if (this._pingInterval)
        {
            // On arrête l'envoi de ping aux clients
            clearInterval(this._pingInterval);

            this._pingInterval = undefined;
        }
    }

    /**
     * Envoie un ping aux clients du salon.
     *
     * @private
     */

    private _pingClients()
    {
        this._clients.forEach((client: Client) =>
        {
            client.ping(this._options.missedPingsLimit);
        });
    }
}
