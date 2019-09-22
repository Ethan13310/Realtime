// Copyright (c) 2019 Ethan Margaillan <contact@ethan.jp>.
// Licensed under the MIT Licence - https://raw.githubusercontent.com/Ethan13310/Realtime/master/LICENSE

import * as WebSocket from 'ws';
import { EventEmitter } from 'events';

/**
 * Représentation d'un client connecté à un salon.
 *
 * @interface IClientSummary
 */

export interface IClientSummary
{
    /**
     * L'id du client.
     */
    id: string;

    /**
     * Les propriétés du client.
     */
    properties?: any;
}

export class Client extends EventEmitter
{
    /**
     * Le socket du client.
     */
    private _socket: WebSocket;

    /**
     * L'id du client.
     */
    private readonly _id: string;

    /**
     * Les propriétés du client.
     */
    private readonly _properties: any;

    /**
     * Nombre de pings manqués.
     */
    private _missedPings: number = 0;

    /**
     * Constructeur du client.
     *
     * @param {WebSocket} socket - Le socket du client.
     * @param {string} id - L'id du client.
     * @param {*} [properties] - Les propriétés du client.
     */

    public constructor(socket: WebSocket, id: string, properties?: any)
    {
        super();

        // Le socket du client
        this._socket = socket;

        // L'id du client
        this._id = id;

        // Les propriétés du client
        this._properties = properties;

        // Réception d'un message
        this._socket.on('message', (message: any) =>
        {
            this.emit('message', message);
        });

        // Réception d'un pong
        this._socket.on('pong', () =>
        {
            this._missedPings = 0;
        });

        // Erreur du socket, on déconnecte le client
        this._socket.on('error', () =>
        {
            this.terminate();
        });
    }

    /**
     * Retourne l'id du client.
     *
     * @returns {string}
     */

    public get id(): string
    {
        return this._id;
    }

    /**
     * Retourne les propriétés du client.
     *
     * @returns {*}
     */

    public get properties(): any
    {
        return this._properties;
    }

    /**
     * Retourne un résumé des informations du client (id et propriétés).
     *
     * @returns {IClientSummary}
     */

    public get summary(): IClientSummary
    {
        return {
            id: this.id,
            properties: this.properties
        };
    }

    /**
     * Envoie un message au client.
     *
     * @param {*} message - Le message à envoyer.
     */

    public send(message: any)
    {
        if (!this._isClosing)
        {
            if (typeof message !== 'string')
            {
                // On convertit les données JSON en strings pour le transport
                // par WebSocket
                message = JSON.stringify(message);
            }

            this._socket.send(message, (error) =>
            {
                if (error)
                {
                    // Erreur du socket, on déconnecte le client
                    this.terminate();
                }
            });
        }
    }

    /**
     * Envoie un ping au client. Si trop de pings ont été manqués, alors le
     * client se fera déconnecters.
     *
     * @param {number} [missedLimit] - Le nombre maximal de pings manqués avant
     *        que le client se fasse déconnecter. Si cette valeur n'est pas
     *        définie, alors aucune limite ne s'applique.
     */

    public ping(missedLimit?: number)
    {
        if (!this._isClosing)
        {
            if (missedLimit !== undefined && this._missedPings >= missedLimit)
            {
                // Le nombre maximal de pings manqués a été atteint, on
                // déconnecte le client
                return this.terminate();
            }

            this._missedPings++;
            this._socket.ping();
        }
    }

    /**
     * Déconnecte le client.
     */

    public disconnect()
    {
        if (!this._isClosing)
        {
            this._socket.close();

            // On notifie le room server de la fermeture du socket
            this._socket.emit('close');
        }

        this._removeAllListeners();
    }

    /**
     * Force la déconnexion du client.
     */

    public terminate()
    {
        if (!this._isClosing)
        {
            this._socket.terminate();

            // On notifie le room server de la fermeture du socket
            this._socket.emit('close');
        }

        this._removeAllListeners();
    }

    /**
     * Supprime tous les listeners du client et de son socket.
     *
     * @private
     */

    private _removeAllListeners()
    {
        this._socket.removeAllListeners();

        this.removeAllListeners();
    }

    /**
     * Détermine si le socket est fermé ou en cours de fermeture.
     *
     * @returns {boolean}
     * @private
     */

    private get _isClosing(): boolean
    {
        return this._socket.readyState >= WebSocket.CLOSING;
    }
}
