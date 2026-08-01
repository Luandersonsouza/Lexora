# Lexora

Servidor local e interface para registrar solicitacoes de pesquisas juridicas.

## Executar

```powershell
python server.py
```

Abra `http://127.0.0.1:8080` no navegador. O banco SQLite e criado em `data/lexora.db`.

## API local

| Metodo | Rota | Finalidade |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Login demonstrativo e emissao de token local. |
| `GET` | `/api/health` | Estado do servidor. |
| `POST` | `/api/researches` | Registra uma solicitacao de pesquisa. |
| `GET` | `/api/researches` | Lista as ultimas 50 solicitacoes. |
| `GET` | `/api/researches/:id` | Detalha uma solicitacao. |

As novas solicitacoes ficam com estado `queued`. Um worker local consulta o Google pelo nome completo entre aspas e atualiza o registro para `running`, `completed` ou `failed`. Resultados e mensagens de erro permanecem no SQLite. Se o Google devolver uma pagina sem links processaveis, a solicitacao fica como `failed`, e nao como uma busca concluida com zero resultados.

O worker interrompe a consulta quando o Google apresenta CAPTCHA ou bloqueio; ele nao tenta contornar essas protecoes.

## Pagina hospedada

Quando a interface for publicada no GitHub Pages, ela usara `http://127.0.0.1:8080` como API. Portanto, o visitante ainda precisa executar `python server.py` em sua propria maquina para fazer login, salvar configuracoes ou iniciar pesquisas. O servidor aceita requisicoes CORS para esse fluxo local; em producao, substitua-o por uma API HTTPS com autenticacao real.
