"""Validate exported workspace structure before inserting any restored projects."""
import math

from engine import DIMENSIONS, FIELDS, cited


def require(condition):
    if not condition:
        raise ValueError('备份结构无效')


def strings(record, keys):
    require(isinstance(record, dict))
    require(all(isinstance(record[key], str) for key in keys))


def number(value):
    require(type(value) in (int, float) and math.isfinite(value))


def chunks_valid(chunks):
    require(isinstance(chunks, list))
    identifiers = set()
    for chunk in chunks:
        strings(chunk, ['id', 'text', 'materialId', 'materialName', 'location'])
        require(chunk['id'] not in identifiers)
        identifiers.add(chunk['id'])
        require(chunk['page'] is None or (type(chunk['page']) is int and chunk['page'] > 0))


def profile_valid(profile, chunks):
    require(isinstance(profile, dict))
    require(type(profile['version']) is int and profile['version'] > 0)
    require(type(profile['stale']) is bool and type(profile['demo']) is bool)
    number(profile['createdAt'])
    if profile['confirmedAt'] is not None:
        number(profile['confirmedAt'])
    items = profile['items']
    require(isinstance(items, list) and [item['field'] for item in items] == FIELDS)
    for item in items:
        strings(item, ['field', 'content', 'sourceType'])
        require(item['sourceType'] in ['material', 'missing', 'user'])
        cited(chunks, item['refs'])


def analysis_valid(analysis, chunks):
    strings(analysis, ['kind', 'action', 'category', 'reason', 'suggestion', 'uncertainty'])
    require(analysis['action'] in ['follow', 'switch', 'finish'])
    require(analysis['category'] in ['回答未说明', '材料未展示', '待澄清'])
    cited(chunks, analysis['refs'])


def validate_project(project):
    strings(project, ['id', 'title'])
    number(project['createdAt'])
    number(project['updatedAt'])
    require(isinstance(project['materials'], list) and len(project['materials']) <= 3)
    chunks = []
    for material in project['materials']:
        strings(material, ['id', 'name', 'digest', 'kind', 'status', 'pdf'])
        require(material['kind'] in ['text', 'pdf'] and material['status'] == 'ready')
        require(type(material['pageCount']) is int and material['pageCount'] > 0)
        require(isinstance(material['warnings'], list) and all(isinstance(w, str) for w in material['warnings']))
        number(material['createdAt'])
        chunks_valid(material['chunks'])
        chunks.extend(material['chunks'])
    chunks_valid(chunks)
    if project['profile'] is not None:
        profile_valid(project['profile'], chunks)
    require(isinstance(project['profiles'], list))
    for profile in project['profiles']:
        profile_valid(profile, chunks)
    require(isinstance(project['sessions'], list))
    for session in project['sessions']:
        strings(session, ['id', 'mode', 'status', 'target'])
        require(session['mode'] in ['formal', 'coach', 'practice'])
        require(session['status'] in ['waiting', 'reviewing', 'pending', 'finished'])
        require(type(session['demo']) is bool and session['minutes'] in [10, 12, 15])
        require(type(session['version']) is int and session['version'] >= 0)
        number(session['createdAt'])
        number(session['deadline'])
        require(session['error'] is None or isinstance(session['error'], str))
        for key in ['sourceSession', 'findingId']:
            require(session[key] is None or isinstance(session[key], str))
        require(isinstance(session['requests'], dict) and all(isinstance(k, str) and v is True for k, v in session['requests'].items()))
        chunks_valid(session['chunks'])
        profile_valid(session['profile'], session['chunks'])
        require(isinstance(session['turns'], list) and bool(session['turns']))
        identifiers = set()
        for index, turn in enumerate(session['turns'], 1):
            strings(turn, ['id', 'question', 'dimension', 'role'])
            require(turn['id'] not in identifiers)
            require(turn['parentId'] is None or turn['parentId'] in identifiers)
            identifiers.add(turn['id'])
            require(turn['dimension'] in DIMENSIONS and turn['number'] == index)
            require(type(turn['depth']) is int and 0 <= turn['depth'] <= 3)
            number(turn['createdAt'])
            cited(session['chunks'], turn['refs'])
            require(isinstance(turn['attempts'], list) and len(turn['attempts']) <= 5)
            if 'hints' in turn:
                require(isinstance(turn['hints'], list) and len(turn['hints']) == 3 and all(isinstance(h, str) for h in turn['hints']))
            for attempt in turn['attempts']:
                strings(attempt, ['id', 'text', 'operation'])
                require(attempt['operation'] in ['answer', 'skip', 'retry', 'deepen'])
                number(attempt['createdAt'])
                if attempt['analysis'] is not None:
                    analysis_valid(attempt['analysis'], session['chunks'])
        if session['status'] == 'pending':
            require(bool(session['turns'][-1]['attempts']))
        report = session['report']
        require((report is not None) == (session['status'] == 'finished'))
        if report is not None:
            number(session['endedAt'])
            number(report['createdAt'])
            strings(report, ['summary'])
            require(isinstance(report['coverage'], dict) and set(report['coverage']) == set(DIMENSIONS))
            require(all(isinstance(value, str) for value in report['coverage'].values()))
            require(isinstance(report['findings'], list))
            for finding in report['findings']:
                strings(finding, ['id', 'turnId', 'attemptId', 'dimension', 'category', 'reason', 'question', 'answer', 'uncertainty', 'suggestion', 'actionType', 'criterion', 'priority'])
                require(finding['turnId'] in identifiers and type(finding['done']) is bool)
                cited(session['chunks'], finding['refs'])
